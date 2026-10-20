// ログインとログインセッション（#155。spec/cloud.md 10.7）
//
// - /auth/login/<provider>?return=<パス>: state と PKCE の値を作って D1 に置き、プロバイダへ送る
// - /auth/callback/<provider>: state を確かめて（1 回だけ・10 分）、コードをトークンに替え、ユーザーを決める
// - /auth/logout（POST）: ログインセッションを消す
// 1 人が複数の手段でログインしても 1 人のユーザーにまとめる。同じプロバイダの同じ ID なら同じユーザー。
// メールアドレスで自動に紐付けはしない（足すのは、ログインしている状態で設定から: ?link=1）
import {
    base64url,
    clearSessionCookie,
    error,
    getCookie,
    json,
    randomToken,
    safeReturnTo,
    sameOrigin,
    sessionCookie,
    sha256,
    SESSION_COOKIE,
} from './http';
import type { Env } from './index';
import { CONFIGS, exchangeCode, isProvider, type Profile, type Provider } from './providers';

// ログインを始めてから戻ってくるまでに待つ時間
const STATE_TTL_MS = 10 * 60 * 1000;
// ログインセッションの長さ
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// last_seen_at を書き直す間隔（毎回書かないように）
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type SessionUser = { userId: string; sessionId: string };

function redirect(location: string, headers: HeadersInit = {}): Response {
    return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

function callbackUrl(request: Request, provider: Provider): string {
    return `${new URL(request.url).origin}/auth/callback/${provider}`;
}

// ログインしているユーザー（Cookie のログインセッションから）。いなければ null
export async function currentUser(request: Request, env: Env): Promise<SessionUser | null> {
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
    return { userId: row.user_id, sessionId: row.id };
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
    const [, , action, provider] = path.split('/');
    if (action === 'logout' && request.method === 'POST') {
        return logout(request, env);
    }
    if (!provider || !isProvider(provider)) {
        return error(404, 'ログインの手段がありません');
    }
    if (action === 'login' && request.method === 'GET') {
        return login(request, env, provider);
    }
    if (action === 'callback' && request.method === 'GET') {
        return callback(request, env, provider);
    }
    return error(404, 'Not found');
}

async function login(request: Request, env: Env, provider: Provider): Promise<Response> {
    const config = CONFIGS[provider];
    const clientId = config.clientId(env);
    if (!clientId) {
        return error(503, 'このログインの手段は、まだ使えません');
    }
    const url = new URL(request.url);
    let linkUserId: string | null = null;
    if (url.searchParams.get('link') === '1') {
        // ログイン手段を足す（ログインしている人だけ）
        const user = await currentUser(request, env);
        if (!user) {
            return error(401, 'ログインしてください');
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
        'INSERT INTO oauth_states (state_hash, provider, code_verifier, return_to, link_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
        .bind(
            await sha256(state),
            provider,
            verifier,
            safeReturnTo(url.searchParams.get('return')),
            linkUserId,
            now,
            now + STATE_TTL_MS,
        )
        .run();
    const authorize = new URL(config.authorizeUrl);
    authorize.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: callbackUrl(request, provider),
        scope: config.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }).toString();
    return redirect(authorize.toString());
}

async function callback(request: Request, env: Env, provider: Provider): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state) {
        return error(400, 'ログインをやり直してください（state がありません）');
    }
    // state は 1 回だけ使える（読んだら消す）
    const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
        .bind(await sha256(state))
        .first<{
            provider: string;
            code_verifier: string;
            return_to: string;
            link_user_id: string | null;
            expires_at: number;
        }>();
    if (!row || row.provider !== provider || row.expires_at <= Date.now()) {
        return error(400, 'ログインをやり直してください（期限が切れたか、使い終わった state です）');
    }
    if (!code) {
        // プロバイダの画面で断った
        return redirect(row.return_to);
    }
    let profile: Profile;
    try {
        const token = await exchangeCode(provider, env, code, row.code_verifier, callbackUrl(request, provider));
        profile = await CONFIGS[provider].profile(token);
    } catch {
        return error(502, 'ログインできませんでした。もう一度試してください');
    }
    const result = await resolveUser(env, provider, profile, row.link_user_id);
    if ('error' in result) {
        return error(409, result.error);
    }
    if (row.link_user_id) {
        // 足しただけ。今のログインセッションのまま
        return redirect(row.return_to);
    }
    const token = randomToken();
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
        .bind(crypto.randomUUID(), result.userId, await sha256(token), now, now + SESSION_TTL_MS, now)
        .run();
    return redirect(row.return_to, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
}

// プロバイダの ID から、ユーザーを決める（なければ作る。足すときは今のユーザーに付ける）
async function resolveUser(
    env: Env,
    provider: Provider,
    profile: Profile,
    linkUserId: string | null,
): Promise<{ userId: string } | { error: string }> {
    const now = Date.now();
    const existing = await env.DB.prepare(
        'SELECT user_id FROM auth_identities WHERE provider = ? AND provider_subject = ?',
    )
        .bind(provider, profile.subject)
        .first<{ user_id: string }>();
    if (existing) {
        if (linkUserId && existing.user_id !== linkUserId) {
            return { error: 'このアカウントは、ほかのユーザーのログイン手段になっています' };
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
