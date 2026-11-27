// ログインとログインセッション（#155。spec/cloud.md 10.7）
//
// - /auth/login/<provider>?return=<パス>: state と PKCE の値を作って D1 に置き、プロバイダへ送る
// - /auth/callback/<provider>: state を確かめて（1 回だけ・10 分）、コードをトークンに替え、ユーザーを決める
// - /auth/logout（POST）: ログインセッションを消す
// - /auth/app/login/<provider>・/auth/app/token・/auth/app/logout: iOS アプリのログイン（#441。appAuth.ts）
// 1 人が複数の手段でログインしても 1 人のユーザーにまとめる。同じプロバイダの同じ ID なら同じユーザー。
// メールアドレスで自動に紐付けはしない（足すのは、ログインしている状態で設定から: ?link=1）
import {
    type AppLogin,
    appCodeLocation,
    appDeniedLocation,
    bearerUser,
    handleAppLogout,
    handleAppToken,
    parseAppLogin,
} from './appAuth';
import { isAppOrigin } from './appOrigin';
import { type ErrorCode, pageError } from './errors';
import {
    type SessionUser,
    base64url,
    clearSessionCookie,
    error,
    getCookie,
    json,
    randomToken,
    safeReturnTo,
    sameOrigin,
    sameString,
    sessionCookie,
    sha256,
    SESSION_COOKIE,
} from './http';
import type { Env } from './index';
import { rememberUser } from './metrics';
import { CONFIGS, exchangeCode, isProvider, type Profile, type Provider } from './providers';

// ログインを始めてから戻ってくるまでに待つ時間
const STATE_TTL_MS = 10 * 60 * 1000;
// ログインセッションの長さ
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// last_seen_at を書き直す間隔（毎回書かないように）
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type { SessionUser };

function redirect(location: string, headers: HeadersInit = {}): Response {
    return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

function callbackUrl(request: Request, provider: Provider): string {
    return `${new URL(request.url).origin}/auth/callback/${provider}`;
}

// ログインしているユーザー（/h/・/me・/pair の確認と承認）。いなければ null。
// Authorization: Bearer があればアプリのトークンだけで決め、Cookie は読まない（#441。トークンが違えば、Cookie があっても
// ログインしていない扱い）。なければ Cookie のログインセッション（cookieUser）
export async function currentUser(request: Request, env: Env): Promise<SessionUser | null> {
    const authorization = request.headers.get('Authorization');
    if (authorization !== null && /^bearer\b/i.test(authorization.trim())) {
        return bearerUser(request, env, authorization);
    }
    return cookieUser(request, env);
}

// Cookie のログインセッションのユーザー。いなければ null。
// アプリに同梱した画面のオリジン（#440）からのものは Cookie を読まない（Cookie で認めるのは自分のオリジンの画面だけ）
export async function cookieUser(request: Request, env: Env): Promise<SessionUser | null> {
    if (isAppOrigin(request, env)) {
        return null;
    }
    const token = getCookie(request, SESSION_COOKIE);
    if (!token) {
        return null;
    }
    const now = Date.now();
    const row = await env.DB.prepare(
        'SELECT id, user_id, last_seen_at FROM web_sessions WHERE token_hash = ? AND expires_at > ?',
    )
        .bind(await sha256(token), now)
        .first<{ id: string; user_id: string; last_seen_at: number }>();
    if (!row) {
        return null;
    }
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
        await env.DB.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run();
    }
    // 計測（#163）で、このリクエストのユーザーとして使う
    rememberUser(request, row.user_id);
    return { userId: row.user_id, sessionId: row.id, kind: 'web' };
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
    const [, , action, provider] = path.split('/');
    if (action === 'logout' && request.method === 'POST') {
        return logout(request, env);
    }
    if (action === 'app') {
        return handleApp(request, env, path);
    }
    if (!provider || !isProvider(provider)) {
        return pageError(request, 404, 'loginMethod.unknown');
    }
    if (action === 'login' && request.method === 'GET') {
        return login(request, env, provider);
    }
    if (action === 'callback' && request.method === 'GET') {
        return callback(request, env, provider);
    }
    return error(404, 'Not found');
}

// iOS アプリのログイン（#441。appAuth.ts）。
// /auth/app/login/<provider>（システムのログイン画面で開く）・/auth/app/token・/auth/app/logout（アプリのネイティブのコードから）
async function handleApp(request: Request, env: Env, path: string): Promise<Response> {
    const [, , , step, provider] = path.split('/');
    if (step === 'login' && request.method === 'GET' && provider && isProvider(provider)) {
        const app = parseAppLogin(new URL(request.url));
        // ログイン手段を足す（?link=1）のは Cookie のログインセッションが要るので、アプリのログインではしない
        if (!app || new URL(request.url).searchParams.has('link')) {
            return pageError(request, 400, 'login.badAppRequest');
        }
        return login(request, env, provider, app);
    }
    if (path === '/auth/app/token' && request.method === 'POST') {
        return handleAppToken(request, env);
    }
    if (path === '/auth/app/logout' && request.method === 'POST') {
        return handleAppLogout(request, env);
    }
    return error(404, 'Not found');
}

// app は、アプリから始めたログインのとき（コールバックで Cookie の代わりに一度だけのコードを作ってアプリへ戻す）
async function login(request: Request, env: Env, provider: Provider, app: AppLogin | null = null): Promise<Response> {
    const config = CONFIGS[provider];
    const clientId = config.clientId(env);
    if (!clientId) {
        return pageError(request, 503, 'loginMethod.unavailable');
    }
    const url = new URL(request.url);
    let linkUserId: string | null = null;
    if (!app && url.searchParams.get('link') === '1') {
        // ログイン手段を足す（Cookie でログインしている人だけ。トップレベルの遷移なので Authorization は付かない）
        const user = await cookieUser(request, env);
        if (!user) {
            return pageError(request, 401, 'login.required');
        }
        linkUserId = user.userId;
    }
    const state = randomToken();
    const verifier = randomToken(48);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const now = Date.now();
    // 期限切れの途中の状態は、ついでに消す
    await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now).run();
    await env.DB.prepare(
        'INSERT INTO oauth_states (state_hash, provider, code_verifier, return_to, link_user_id, app_challenge, app_state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
        .bind(
            await sha256(state),
            provider,
            verifier,
            app ? '/' : safeReturnTo(url.searchParams.get('return')),
            linkUserId,
            app?.challenge ?? null,
            app?.state ?? null,
            now,
            now + STATE_TTL_MS,
        )
        .run();
    // ついでに、期限切れのログインセッションも消す
    await env.DB.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').bind(now).run();
    const authorize = new URL(config.authorizeUrl);
    authorize.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: callbackUrl(request, provider),
        scope: config.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // アプリのログインだけ、毎回アカウントを選ぶ（同意する）画面を出す（ブラウザのログインは今まで通り）
        ...(app ? config.appPrompt : {}),
    }).toString();
    // state をこのブラウザにも持たせ、戻ってきたときに同じブラウザかを確かめる（ログイン CSRF の対策。
    // ほかの人が始めたログインの続きの URL を踏ませて、その人のアカウントにログインさせる・手段を足させるのを防ぐ）
    return redirect(authorize.toString(), { 'Set-Cookie': stateCookie(state, STATE_TTL_MS / 1000) });
}

const STATE_COOKIE = '__Host-rw_oauth_state';

function stateCookie(value: string, maxAgeSec: number): string {
    return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

async function callback(request: Request, env: Env, provider: Provider): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state) {
        return pageError(request, 400, 'login.noState');
    }
    // ログインを始めたのと同じブラウザか
    const browserState = getCookie(request, STATE_COOKIE);
    if (!browserState || !sameString(browserState, state)) {
        return pageError(request, 400, 'login.otherBrowser');
    }
    // state は 1 回だけ使える（読んだら消す）
    const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
        .bind(await sha256(state))
        .first<{
            provider: string;
            code_verifier: string;
            return_to: string;
            link_user_id: string | null;
            app_challenge: string | null;
            app_state: string | null;
            expires_at: number;
        }>();
    if (!row || row.provider !== provider || row.expires_at <= Date.now()) {
        return pageError(request, 400, 'login.stateExpired');
    }
    const clearState = { 'Set-Cookie': stateCookie('', 0) };
    // アプリから始めたログイン（#441）。戻る先はアプリ（固定の URL）で、Cookie のログインセッションは作らない
    const app: AppLogin | null =
        row.app_challenge && row.app_state ? { challenge: row.app_challenge, state: row.app_state } : null;
    if (!code) {
        // プロバイダの画面で断った
        return redirect(app ? appDeniedLocation(app) : row.return_to, clearState);
    }
    if (row.link_user_id) {
        // 手段を足すのは、始めた人がまだ同じユーザーでログインしているときだけ
        const user = await cookieUser(request, env);
        if (user?.userId !== row.link_user_id) {
            return pageError(request, 400, 'login.userChanged');
        }
    }
    let profile: Profile;
    try {
        const token = await exchangeCode(provider, env, code, row.code_verifier, callbackUrl(request, provider));
        profile = await CONFIGS[provider].profile(token);
        // ID のない返事を、"undefined" という ID のユーザーにしない
        if (
            typeof profile.subject !== 'string' ||
            !/^[\w.-]{1,128}$/.test(profile.subject) ||
            profile.subject === 'undefined'
        ) {
            throw new Error('no subject');
        }
    } catch {
        return pageError(request, 502, 'login.failed');
    }
    const result = await resolveUser(env, provider, profile, row.link_user_id);
    if ('error' in result) {
        return pageError(request, 409, result.error);
    }
    if (row.link_user_id) {
        // 足しただけ。今のログインセッションのまま
        return redirect(row.return_to, clearState);
    }
    if (app) {
        return redirect(await appCodeLocation(env, result.userId, app), clearState);
    }
    const token = randomToken();
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
        .bind(crypto.randomUUID(), result.userId, await sha256(token), now, now + SESSION_TTL_MS, now)
        .run();
    const headers = new Headers({ Location: row.return_to });
    headers.append('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
    headers.append('Set-Cookie', stateCookie('', 0));
    return new Response(null, { status: 302, headers });
}

// プロバイダの ID から、ユーザーを決める（なければ作る。足すときは今のユーザーに付ける）
async function resolveUser(
    env: Env,
    provider: Provider,
    profile: Profile,
    linkUserId: string | null,
): Promise<{ userId: string } | { error: ErrorCode }> {
    const now = Date.now();
    const existing = await env.DB.prepare(
        'SELECT user_id FROM auth_identities WHERE provider = ? AND provider_subject = ?',
    )
        .bind(provider, profile.subject)
        .first<{ user_id: string }>();
    if (existing) {
        if (linkUserId && existing.user_id !== linkUserId) {
            return { error: 'loginMethod.usedByOtherUser' };
        }
        // 表示用の名前とメールは新しいものにする
        await env.DB.prepare(
            'UPDATE auth_identities SET email = ?, display_name = ? WHERE provider = ? AND provider_subject = ?',
        )
            .bind(profile.email, profile.displayName, provider, profile.subject)
            .run();
        return { userId: existing.user_id };
    }
    const userId = linkUserId ?? crypto.randomUUID();
    const statements = [];
    if (!linkUserId) {
        statements.push(
            env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(
                userId,
                profile.displayName,
                now,
            ),
        );
    }
    statements.push(
        env.DB.prepare(
            'INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), userId, provider, profile.subject, profile.email, profile.displayName, now),
    );
    await env.DB.batch(statements);
    return { userId };
}

async function logout(request: Request, env: Env): Promise<Response> {
    if (!sameOrigin(request)) {
        return error(403, 'Forbidden');
    }
    const token = getCookie(request, SESSION_COOKIE);
    if (token) {
        await env.DB.prepare('DELETE FROM web_sessions WHERE token_hash = ?')
            .bind(await sha256(token))
            .run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
