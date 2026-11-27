// iOS アプリのログイン（#441。spec/cloud.md 10.7 の「アプリのログイン」）
//
// 1. アプリが PKCE の verifier と state を作り、システムのログイン画面（ASWebAuthenticationSession）で
//    /auth/app/login/<provider>?challenge=<S256>&state=<state> を開く（OAuth の流れはブラウザのログインと同じ）
// 2. コールバックで、Cookie の代わりに一度だけ使える短い期限のコードを作り、remotewhisper://auth/callback へ戻す
// 3. アプリは POST /auth/app/token でコードと verifier をトークンに替える（コードを横取りされても verifier がなければ使えない）
// 4. API は Authorization: Bearer <アクセストークン>。ヘッダーを付けられない WebSocket と音声の再生は、
//    POST /me/tickets で作った短い期限のチケットを ?rw_ticket= に付ける（長い期限のトークンは URL に載せない）
//
// トークンの認可はここで終わらせる。ホストに渡すのは今まで通り署名（X-RW-Relay）だけ（relay.ts）
import { isAppOrigin } from './appOrigin';
import { apiError } from './errors';
import {
    type SessionUser,
    TOO_LARGE,
    base64url,
    error,
    json,
    randomToken,
    readJsonLimited,
    sameOrigin,
    sameString,
    sha256,
} from './http';
import type { Env } from './index';
import { rememberUser } from './metrics';

// ログインのあとにアプリへ戻る先（固定。#454 で登録したカスタムスキーム）
export const APP_CALLBACK = 'remotewhisper://auth/callback';
// 一度だけのコードの期限
export const APP_CODE_TTL_MS = 2 * 60 * 1000;
// アクセストークンの期限
export const ACCESS_TTL_MS = 60 * 60 * 1000;
// 更新トークンの期限（更新するたびに延びる）
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
// チケットの期限。WebSocket は一度だけ、音声は期限まで何度でも（Range で読み直すため）
export const WS_TICKET_TTL_MS = 60 * 1000;
export const MEDIA_TICKET_TTL_MS = 60 * 60 * 1000;
// 1 つの端末が持てるチケットの数（期限前のもの。超えたら古いものから消す。D1 に溜めないため）。
// 音声のチケットは開いた録音ごとに 1 時間残るので、ふつうに使う分よりは多めにする
export const MAX_TICKETS_PER_SESSION = 30;
// 1 人が持てるアプリのログインセッションの数（超えたら、いちばん長く使っていないものから消す）
export const MAX_APP_SESSIONS = 20;
// last_seen_at を書き直す間隔
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const TICKET_PARAM = 'rw_ticket';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 の code_verifier と、S256 の code_challenge（SHA-256 の base64url で 43 文字）
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const APP_STATE = /^[A-Za-z0-9_-]{16,128}$/;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 音声のチケットで開けるのは、セッションの録音ファイルだけ（ホストの API の 7.1 節）
const MEDIA_PATH = /^\/api\/projects\/[A-Za-z0-9-]{1,200}\/sessions\/[A-Za-z0-9-]{1,64}\/recording$/;

// --- ログインを始める・戻る ---

export type AppLogin = { challenge: string; state: string };

// /auth/app/login/<provider> のクエリ。形が違えば null
export function parseAppLogin(url: URL): AppLogin | null {
    const challenge = url.searchParams.get('challenge') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!CHALLENGE.test(challenge) || !APP_STATE.test(state) || url.searchParams.get('challenge_method') !== 'S256') {
        return null;
    }
    return { challenge, state };
}

function callbackLocation(params: Record<string, string>): string {
    return `${APP_CALLBACK}?${new URLSearchParams(params).toString()}`;
}

// ログインできた。一度だけのコードを作り、アプリに戻す URL を返す
export async function appCodeLocation(env: Env, userId: string, login: AppLogin): Promise<string> {
    const code = randomToken();
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('DELETE FROM app_auth_codes WHERE expires_at <= ?').bind(now),
        env.DB.prepare(
            'INSERT INTO app_auth_codes (code_hash, user_id, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(await sha256(code), userId, login.challenge, now, now + APP_CODE_TTL_MS),
    ]);
    return callbackLocation({ code, state: login.state });
}

// プロバイダの画面で断った
export function appDeniedLocation(login: AppLogin): string {
    return callbackLocation({ error: 'access_denied', state: login.state });
}

// --- トークン（アプリのネイティブのコードが呼ぶ） ---

type Tokens = { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number };

// Cookie を読まないので CSRF にはならないが、ほかのサイトの画面からは受けない（ネイティブは Origin を付けない）
function callerAllowed(request: Request, env: Env): boolean {
    return request.headers.get('Origin') === null || sameOrigin(request) || isAppOrigin(request, env);
}

function deviceName(value: unknown): string {
    const name = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
    return name.length > 0 && name.length <= 64 ? name : 'iOS アプリ';
}

async function newTokens(now: number) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    return {
        tokens: {
            accessToken,
            accessExpiresAt: now + ACCESS_TTL_MS,
            refreshToken,
            refreshExpiresAt: now + REFRESH_TTL_MS,
        } satisfies Tokens,
        accessHash: await sha256(accessToken),
        refreshHash: await sha256(refreshToken),
    };
}

// POST /auth/app/token。本文は JSON で、
// - { grantType: 'authorization_code', code, codeVerifier, deviceName? }: ログインのあとのコードを替える
// - { grantType: 'refresh_token', refreshToken }: 更新（アクセストークンも更新トークンも替える。前の更新トークンは使えなくなる）
export async function handleAppToken(request: Request, env: Env): Promise<Response> {
    if (!callerAllowed(request, env)) {
        return error(403, 'Forbidden');
    }
    const raw = await readJsonLimited(request, 2048);
    if (raw === TOO_LARGE) {
        return apiError(413, 'request.tooLarge');
    }
    const data = (raw ?? {}) as Record<string, unknown>;
    const now = Date.now();
    if (data.grantType === 'authorization_code') {
        return exchangeCode(env, data, now);
    }
    if (data.grantType === 'refresh_token') {
        return refresh(env, data, now);
    }
    return apiError(400, 'appToken.badGrantType');
}

async function exchangeCode(env: Env, data: Record<string, unknown>, now: number): Promise<Response> {
    const code = typeof data.code === 'string' ? data.code : '';
    const verifier = typeof data.codeVerifier === 'string' ? data.codeVerifier : '';
    if (!TOKEN.test(code) || !VERIFIER.test(verifier)) {
        return apiError(400, 'login.retry');
    }
    // コードは一度だけ（読んだら消す。verifier が違っても消す）
    const row = await env.DB.prepare('DELETE FROM app_auth_codes WHERE code_hash = ? RETURNING *')
        .bind(await sha256(code))
        .first<{ user_id: string; code_challenge: string; expires_at: number }>();
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    if (!row || row.expires_at <= now || !sameString(challenge, row.code_challenge)) {
        return apiError(400, 'login.retry');
    }
    const { tokens, accessHash, refreshHash } = await newTokens(now);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').bind(now),
        env.DB.prepare(
            `INSERT INTO app_sessions (id, user_id, name, access_hash, access_expires_at, refresh_hash, expires_at, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(),
            row.user_id,
            deviceName(data.deviceName),
            accessHash,
            tokens.accessExpiresAt,
            refreshHash,
            tokens.refreshExpiresAt,
            now,
            now,
        ),
        env.DB.prepare(
            `DELETE FROM app_sessions WHERE user_id = ?1 AND id NOT IN
               (SELECT id FROM app_sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC, created_at DESC LIMIT ?2)`,
        ).bind(row.user_id, MAX_APP_SESSIONS),
    ]);
    return json(tokens);
}

async function refresh(env: Env, data: Record<string, unknown>, now: number): Promise<Response> {
    const token = typeof data.refreshToken === 'string' ? data.refreshToken : '';
    if (!TOKEN.test(token)) {
        return apiError(401, 'login.required');
    }
    const { tokens, accessHash, refreshHash } = await newTokens(now);
    // 替えるのと確かめるのを 1 つの文にする（同じ更新トークンで 2 回替えられない）
    const row = await env.DB.prepare(
        `UPDATE app_sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, expires_at = ?, last_seen_at = ?
         WHERE refresh_hash = ? AND expires_at > ? RETURNING id`,
    )
        .bind(accessHash, tokens.accessExpiresAt, refreshHash, tokens.refreshExpiresAt, now, await sha256(token), now)
        .first<{ id: string }>();
    if (!row) {
        return apiError(401, 'login.required');
    }
    return json(tokens);
}

// POST /auth/app/logout。本文は { refreshToken }。その端末のログインセッションを消す（なくても 200）
export async function handleAppLogout(request: Request, env: Env): Promise<Response> {
    if (!callerAllowed(request, env)) {
        return error(403, 'Forbidden');
    }
    const raw = await readJsonLimited(request, 1024);
    if (raw === TOO_LARGE) {
        return apiError(413, 'request.tooLarge');
    }
    const token = (raw as { refreshToken?: unknown } | null)?.refreshToken;
    if (typeof token === 'string' && TOKEN.test(token)) {
        await env.DB.prepare('DELETE FROM app_sessions WHERE refresh_hash = ?')
            .bind(await sha256(token))
            .run();
    }
    return json({ ok: true });
}

// --- 認可 ---

// Authorization: Bearer <アクセストークン> のユーザー。形が違う・期限切れ・消した端末・ほかのサイトの画面からなら null。
// Authorization があるときは Cookie を読まない（auth.ts の currentUser）
export async function bearerUser(request: Request, env: Env, header: string): Promise<SessionUser | null> {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    // ブラウザの画面が付けられるのは、自分のオリジンかアプリに同梱した画面だけ（盗まれたトークンをほかのサイトで使わせない）
    if (!m || !callerAllowed(request, env)) {
        return null;
    }
    const now = Date.now();
    const row = await env.DB.prepare(
        'SELECT id, user_id, last_seen_at FROM app_sessions WHERE access_hash = ? AND access_expires_at > ? AND expires_at > ?',
    )
        .bind(await sha256(m[1]), now, now)
        .first<{ id: string; user_id: string; last_seen_at: number }>();
    if (!row) {
        return null;
    }
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
        await env.DB.prepare('UPDATE app_sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run();
    }
    rememberUser(request, row.user_id);
    return { userId: row.user_id, sessionId: row.id, kind: 'app' };
}

// ?rw_ticket= のチケットのユーザー（relay.ts）。WebSocket は ws のチケットで /ws だけ（使ったら消す）、
// GET・HEAD は media のチケットで、作ったときのパスだけ。合わなければ null
export async function ticketUser(
    request: Request,
    env: Env,
    ticket: string,
    hostId: string,
    hostPath: string,
    websocket: boolean,
): Promise<SessionUser | null> {
    if (!TOKEN.test(ticket)) {
        return null;
    }
    const now = Date.now();
    const hash = await sha256(ticket);
    let row: { app_session_id: string; user_id: string } | null;
    if (websocket) {
        // ブラウザの WebSocket はいつも Origin を付ける。自分のオリジンかアプリの画面だけ
        if (!(sameOrigin(request) || isAppOrigin(request, env))) {
            return null;
        }
        row = await env.DB.prepare(
            `DELETE FROM app_tickets WHERE ticket_hash = ? AND kind = 'ws' AND host_id = ? AND path = ? AND expires_at > ?
             RETURNING app_session_id, user_id`,
        )
            .bind(hash, hostId, hostPath, now)
            .first();
    } else if (request.method === 'GET' || request.method === 'HEAD') {
        row = await env.DB.prepare(
            `SELECT app_session_id, user_id FROM app_tickets
             WHERE ticket_hash = ? AND kind = 'media' AND host_id = ? AND path = ? AND expires_at > ?`,
        )
            .bind(hash, hostId, hostPath, now)
            .first();
    } else {
        return null;
    }
    if (!row) {
        return null;
    }
    // 端末のログインセッションが切れていれば使えない（消したときは CASCADE でチケットも消える）
    const session = await env.DB.prepare('SELECT id FROM app_sessions WHERE id = ? AND expires_at > ?')
        .bind(row.app_session_id, now)
        .first();
    if (!session) {
        return null;
    }
    rememberUser(request, row.user_id);
    return { userId: row.user_id, sessionId: row.app_session_id, kind: 'app' };
}

// クエリから rw_ticket を取り出し、残りのクエリ（ホストに渡すもの）を返す。ほかの引数の書き方は変えない
export function takeTicket(search: string): { ticket: string | null; rest: string } {
    if (!search.includes(TICKET_PARAM)) {
        return { ticket: null, rest: search };
    }
    let ticket: string | null = null;
    const kept: string[] = [];
    for (const part of search.replace(/^\?/, '').split('&')) {
        const [key, ...value] = part.split('=');
        if (key === TICKET_PARAM) {
            // 2 つ以上あれば、どれも使わない（形が違うとして断る）
            ticket = ticket === null ? value.join('=') : '';
        } else if (part !== '') {
            kept.push(part);
        }
    }
    return { ticket, rest: kept.length ? `?${kept.join('&')}` : '' };
}

// POST /me/tickets（アプリのトークンでだけ）。本文は { hostId, kind: 'ws' | 'media', path }
export async function issueTicket(request: Request, env: Env, user: SessionUser): Promise<Response> {
    if (user.kind !== 'app') {
        return apiError(403, 'appTicket.appOnly');
    }
    const raw = await readJsonLimited(request, 1024);
    if (raw === TOO_LARGE) {
        return apiError(413, 'request.tooLarge');
    }
    const data = (raw ?? {}) as { hostId?: unknown; kind?: unknown; path?: unknown };
    const hostId = typeof data.hostId === 'string' ? data.hostId : '';
    const path = typeof data.path === 'string' ? data.path : '';
    const kind = data.kind;
    const pathOk = kind === 'ws' ? path === '/ws' : kind === 'media' ? MEDIA_PATH.test(path) : false;
    if (!HOST_ID.test(hostId) || !pathOk) {
        return apiError(400, 'appTicket.invalid');
    }
    const host = await env.DB.prepare('SELECT id FROM hosts WHERE id = ? AND user_id = ?')
        .bind(hostId, user.userId)
        .first();
    if (!host) {
        return apiError(403, 'host.forbidden');
    }
    const ticket = randomToken();
    const now = Date.now();
    const expiresAt = now + (kind === 'ws' ? WS_TICKET_TTL_MS : MEDIA_TICKET_TTL_MS);
    // 期限切れのチケット（全員の分）を消してから足し、この端末の分が上限を超えたら古いものから消す（同じ batch で）
    await env.DB.batch([
        env.DB.prepare('DELETE FROM app_tickets WHERE expires_at <= ?').bind(now),
        env.DB.prepare(
            `INSERT INTO app_tickets (ticket_hash, app_session_id, user_id, host_id, kind, path, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(await sha256(ticket), user.sessionId, user.userId, hostId, kind, path, now, expiresAt),
        env.DB.prepare(
            `DELETE FROM app_tickets WHERE app_session_id = ?1 AND rowid NOT IN
               (SELECT rowid FROM app_tickets WHERE app_session_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
        ).bind(user.sessionId, MAX_TICKETS_PER_SESSION),
    ]);
    return json({ ticket, expiresAt });
}

// --- 端末の一覧（/me/devices） ---

export async function listDevices(env: Env, user: SessionUser): Promise<Response> {
    const rows = await env.DB.prepare(
        'SELECT id, name, created_at, last_seen_at FROM app_sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at',
    )
        .bind(user.userId, Date.now())
        .all<{ id: string; name: string; created_at: number; last_seen_at: number }>();
    return json({
        devices: rows.results.map((d) => ({
            id: d.id,
            name: d.name,
            createdAt: d.created_at,
            lastSeenAt: d.last_seen_at,
            current: user.kind === 'app' && d.id === user.sessionId,
        })),
    });
}

// 端末を消す（その端末のトークンとチケットはすぐ使えなくなる）
export async function removeDevice(env: Env, user: SessionUser, id: string): Promise<Response> {
    const res = await env.DB.prepare('DELETE FROM app_sessions WHERE id = ? AND user_id = ?')
        .bind(id, user.userId)
        .run();
    if (res.meta.changes === 0) {
        return apiError(404, 'device.notFound');
    }
    return listDevices(env, user);
}
