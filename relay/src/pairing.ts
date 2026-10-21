// ホストの登録（#157。spec/cloud.md 10.5・10.6）
//
// ホスト（トレイ）から（X-RW-Host の署名つき）:
// - POST /pair/start: 申請。登録コード（10 分有効）を返す。DB にはコードのハッシュだけ
// - POST /pair/poll: 承認されたかを聞く。承認されていれば中継の鍵を返す（期限までは何度でも同じもの）
// - POST /pair/unpair: 登録をやめる（申請中なら申請を消す）。トンネルも消す
// - POST /pair/tunnel: 起動のたびに cloudflared のトークンをもらう（#159。トンネルがなければ作る）
// ブラウザから（ログインセッション）:
// - GET /pair/request?code=: 確認の画面に出す申請（PC 名など）
// - POST /pair/approve・/pair/reject {code}: 承認・拒否。承認したときに hosts に入れる
import { currentUser } from './auth';
import { error, json, randomToken, sameOrigin, sha256 } from './http';
import type { Env } from './index';
import { type HostTunnel, MAX_HOSTS_PER_USER, TunnelUnavailable, deleteTunnel, ensureTunnel } from './tunnel';

export const PAIR_TTL_MS = 10 * 60 * 1000;
// 署名の時刻のずれの許し（10.5 節）
const CLOCK_SKEW_SEC = 60;
const MAX_BODY_BYTES = 4096;
// 同じ接続元からの申請は 10 分に 5 回まで。ポーリングは 1 秒に 1 回まで
const START_LIMIT = 5;
const POLL_MIN_INTERVAL_MS = 1000;
// /pair/tunnel は 1 台あたり 60 秒に 1 回まで。1 回で Cloudflare の API を 3 回ほど呼ぶので、5 台でも
// 5 分に 75 回ほどに収める（API の上限は 5 分に 1200 回）。ホストの cloudflared のランナーは 429 を受けても
// 間隔を空けて聞き直す（5 秒から倍にしていく）ので、長くしても登録が止まることはない
const TUNNEL_MIN_INTERVAL_MS = 60 * 1000;
// 登録コードの文字（読み間違えやすい 0・O・1・I は使わない）。32 文字なので 1 バイトの下 5 ビットで偏りなく選べる
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PairingRow = {
    id: string;
    host_id: string;
    host_name: string;
    public_key: string;
    status: 'pending' | 'approved' | 'rejected';
    expires_at: number;
    last_polled_at: number | null;
};

export async function handlePairing(request: Request, env: Env, path: string): Promise<Response> {
    const route = `${request.method} ${path}`;
    switch (route) {
        case 'POST /pair/start':
            return start(request, env);
        case 'POST /pair/poll':
            return poll(request, env);
        case 'POST /pair/unpair':
            return unpair(request, env);
        case 'POST /pair/tunnel':
            return tunnel(request, env);
        case 'GET /pair/request':
        case 'POST /pair/approve':
        case 'POST /pair/reject':
            return fromBrowser(request, env, path);
    }
    return error(404, 'Not found');
}

// --- 署名（10.5 節） ---

export function newCode(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const chars = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

// 画面で打ち直されたコードもそろえる（小文字・空白・ハイフンなし）
export function normalizeCode(value: string | null): string | null {
    const raw = (value ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (raw.length !== 8 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) {
        return null;
    }
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function base64urlDecode(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) {
        return null;
    }
    try {
        const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

async function sha256Hex(body: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

type HostHeader = { hostId: string; ts: number; sig: Uint8Array };

// X-RW-Host: v1;host=<hostId>;ts=<秒>;sig=<base64url>。4 つちょうど、この順だけ
export function parseHostHeader(header: string | null): HostHeader | null {
    const parts = (header ?? '').split(';');
    if (parts.length !== 4 || parts[0] !== 'v1') {
        return null;
    }
    const values: string[] = [];
    for (const [i, name] of ['host', 'ts', 'sig'].entries()) {
        const part = parts[i + 1];
        if (!part.startsWith(`${name}=`) || part.length === name.length + 1) {
            return null;
        }
        values.push(part.slice(name.length + 1));
    }
    const [hostId, ts, sig] = values;
    const signature = base64urlDecode(sig);
    if (!UUID.test(hostId) || !/^\d{1,12}$/.test(ts) || !signature || signature.length !== 64) {
        return null;
    }
    return { hostId, ts: Number(ts), sig: signature };
}

// 署名を確かめる。公開鍵は生の 32 バイトの base64url
async function verifyHost(header: HostHeader, publicKey: string, request: Request, body: Uint8Array): Promise<boolean> {
    if (Math.abs(Date.now() / 1000 - header.ts) > CLOCK_SKEW_SEC) {
        return false;
    }
    const raw = base64urlDecode(publicKey);
    if (!raw || raw.length !== 32) {
        return false;
    }
    const url = new URL(request.url);
    const message = [
        'v1',
        header.hostId,
        String(header.ts),
        request.method.toUpperCase(),
        url.pathname + url.search,
        await sha256Hex(body),
    ].join('\n');
    try {
        const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'Ed25519' }, key, header.sig, new TextEncoder().encode(message));
    } catch {
        return false;
    }
}

async function readBody(request: Request): Promise<Uint8Array | null> {
    const length = Number(request.headers.get('Content-Length') ?? '0');
    if (length > MAX_BODY_BYTES) {
        return null;
    }
    const body = new Uint8Array(await request.arrayBuffer());
    return body.length > MAX_BODY_BYTES ? null : body;
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(body));
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

// --- ホストから ---

async function start(request: Request, env: Env): Promise<Response> {
    const body = await readBody(request);
    const data = body && parseJson(body);
    if (!body || !data) {
        return error(400, 'bad request');
    }
    const { hostId, hostName, publicKey } = data;
    // 制御文字と書式の文字（右から左への上書き・ゼロ幅の文字など）を除く。確認の画面で名前を偽って見せられないように
    const name = typeof hostName === 'string' ? hostName.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
    if (
        typeof hostId !== 'string' ||
        !UUID.test(hostId) ||
        name.length === 0 ||
        name.length > 64 ||
        typeof publicKey !== 'string' ||
        base64urlDecode(publicKey)?.length !== 32
    ) {
        return error(400, 'bad request');
    }
    // 申請する公開鍵と組の秘密鍵を持っていることの証明
    const header = parseHostHeader(request.headers.get('X-RW-Host'));
    if (!header || header.hostId !== hostId || !(await verifyHost(header, publicKey, request, body))) {
        return error(401, 'bad signature');
    }
    const now = Date.now();
    await env.DB.prepare('DELETE FROM pairing_requests WHERE expires_at <= ?').bind(now).run();
    // 接続元ごとの回数の制限（IP アドレスはハッシュにして置く）
    const client = await sha256(`client:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM pairing_requests WHERE client_hash = ? AND created_at > ?',
    )
        .bind(client, now - PAIR_TTL_MS)
        .first<{ n: number }>();
    if ((recent?.n ?? 0) >= START_LIMIT) {
        return error(429, 'too many requests');
    }
    // 登録済み・申請中のホスト ID は断る（ほかの人のホストを別の鍵で乗っ取らせない）
    const taken = await env.DB.prepare(
        'SELECT 1 FROM hosts WHERE id = ?1 UNION ALL SELECT 1 FROM pairing_requests WHERE host_id = ?1',
    )
        .bind(hostId)
        .first();
    if (taken) {
        return error(409, 'host already registered');
    }
    const code = newCode();
    try {
        await env.DB.prepare(
            `INSERT INTO pairing_requests
                (id, code_hash, host_id, host_name, public_key, client_hash, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(crypto.randomUUID(), await sha256(code), hostId, name, publicKey, client, now, now + PAIR_TTL_MS)
            .run();
    } catch {
        // 同じホスト ID の申請が同時に来た（ユニーク索引）
        return error(409, 'host already registered');
    }
    const origin = new URL(request.url).origin;
    return json({
        code,
        url: `${origin}/pair?code=${encodeURIComponent(code)}`,
        expiresInSec: PAIR_TTL_MS / 1000,
    });
}

// 署名つきのリクエストの、ホスト ID と本文を取り出す
async function signedRequest(request: Request) {
    const body = await readBody(request);
    const header = parseHostHeader(request.headers.get('X-RW-Host'));
    return body && header ? { body, header } : null;
}

async function poll(request: Request, env: Env): Promise<Response> {
    const signed = await signedRequest(request);
    if (!signed) {
        return error(401, 'bad signature');
    }
    const now = Date.now();
    const row = await env.DB.prepare(
        `SELECT id, host_id, host_name, public_key, status, expires_at, last_polled_at
         FROM pairing_requests WHERE host_id = ? AND expires_at > ?`,
    )
        .bind(signed.header.hostId, now)
        .first<PairingRow>();
    if (!row) {
        return error(404, 'no pairing request');
    }
    if (!(await verifyHost(signed.header, row.public_key, request, signed.body))) {
        return error(401, 'bad signature');
    }
    if (row.last_polled_at !== null && now - row.last_polled_at < POLL_MIN_INTERVAL_MS) {
        return error(429, 'too many requests');
    }
    await env.DB.prepare('UPDATE pairing_requests SET last_polled_at = ? WHERE id = ?').bind(now, row.id).run();
    if (row.status !== 'approved') {
        return json({ status: row.status });
    }
    // 承認したときに hosts に入れた中継の鍵。返事が落ちても聞き直せるよう、期限までは何度でも返す
    const host = await env.DB.prepare('SELECT relay_key FROM hosts WHERE id = ? AND public_key = ?')
        .bind(row.host_id, row.public_key)
        .first<{ relay_key: string | null }>();
    if (!host?.relay_key) {
        // 承認のあと、画面から外された
        return error(404, 'no pairing request');
    }
    return json({ status: 'approved', relayKey: host.relay_key });
}

async function unpair(request: Request, env: Env): Promise<Response> {
    const signed = await signedRequest(request);
    if (!signed) {
        return error(401, 'bad signature');
    }
    const hostId = signed.header.hostId;
    const host = await env.DB.prepare('SELECT id, public_key, tunnel_id, tunnel_hostname FROM hosts WHERE id = ?')
        .bind(hostId)
        .first<HostTunnel & { public_key: string }>();
    const pending = host
        ? null
        : await env.DB.prepare('SELECT public_key FROM pairing_requests WHERE host_id = ?')
              .bind(hostId)
              .first<{ public_key: string }>();
    const publicKey = host?.public_key ?? pending?.public_key;
    if (!publicKey) {
        return error(404, 'no such host');
    }
    if (!(await verifyHost(signed.header, publicKey, request, signed.body))) {
        return error(401, 'bad signature');
    }
    if (!host) {
        // 申請中なら、行は消さずに取り消し済み（rejected）にして期限まで残す。消すと、申請と取り消しを
        // 繰り返して接続元ごとの回数の制限を抜けられるため。このあとの承認は pending でないので断られる
        await env.DB.prepare("UPDATE pairing_requests SET status = 'rejected' WHERE host_id = ?").bind(hostId).run();
        return json({ ok: true });
    }
    await deleteTunnel(env, host);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM hosts WHERE id = ?').bind(hostId),
        env.DB.prepare('DELETE FROM pairing_requests WHERE host_id = ?').bind(hostId),
    ]);
    return json({ ok: true });
}

// 登録済みのホストが、起動のたびに cloudflared のトークンをもらう（#159）。トンネルがなければ作る。
// 本文の appVersion（任意）は、ホストの一覧（#161）に出す
async function tunnel(request: Request, env: Env): Promise<Response> {
    const signed = await signedRequest(request);
    if (!signed) {
        return error(401, 'bad signature');
    }
    const host = await env.DB.prepare('SELECT id, public_key, tunnel_id, tunnel_hostname FROM hosts WHERE id = ?')
        .bind(signed.header.hostId)
        .first<HostTunnel & { public_key: string }>();
    if (!host) {
        return error(404, 'no such host');
    }
    if (!(await verifyHost(signed.header, host.public_key, request, signed.body))) {
        return error(401, 'bad signature');
    }
    const data = parseJson(signed.body);
    const appVersion =
        typeof data?.appVersion === 'string' && /^[\w.+-]{1,32}$/.test(data.appVersion) ? data.appVersion : null;
    // 呼ぶたびに Cloudflare の API を呼ぶので、1 台あたり TUNNEL_MIN_INTERVAL_MS に 1 回まで（#166）。
    // 間隔の確かめと last_seen_at の更新は同じ文で（同時に来ても 1 つしか通らない）
    const now = Date.now();
    const touched = await env.DB.prepare(
        `UPDATE hosts SET last_seen_at = ?1, app_version = COALESCE(?2, app_version)
         WHERE id = ?3 AND (last_seen_at IS NULL OR last_seen_at <= ?4)`,
    )
        .bind(now, appVersion, host.id, now - TUNNEL_MIN_INTERVAL_MS)
        .run();
    if (!touched.meta.changes) {
        return error(429, 'too many requests');
    }
    try {
        return json(await ensureTunnel(env, host));
    } catch (e) {
        if (e instanceof TunnelUnavailable) {
            return error(503, 'tunnel is not available');
        }
        console.warn(`failed to prepare the tunnel of host ${host.id}: ${(e as Error).message}`);
        return error(502, 'failed to prepare the tunnel');
    }
}

// --- ブラウザから ---

async function fromBrowser(request: Request, env: Env, path: string): Promise<Response> {
    const user = await currentUser(request, env);
    if (!user) {
        return error(401, 'ログインしてください');
    }
    if (request.method !== 'GET' && !sameOrigin(request)) {
        return error(403, 'Forbidden');
    }
    let code: string | null;
    if (request.method === 'GET') {
        code = normalizeCode(new URL(request.url).searchParams.get('code'));
    } else {
        const body = await readBody(request);
        const data = body && parseJson(body);
        code = normalizeCode(typeof data?.code === 'string' ? data.code : null);
    }
    if (!code) {
        return error(400, '登録コードの形が違います');
    }
    const codeHash = await sha256(code);
    const now = Date.now();
    if (path === '/pair/request') {
        const row = await env.DB.prepare(
            'SELECT host_name, status, user_id, expires_at FROM pairing_requests WHERE code_hash = ? AND expires_at > ?',
        )
            .bind(codeHash, now)
            .first<{ host_name: string; status: string; user_id: string | null; expires_at: number }>();
        if (!row) {
            return error(404, '登録の申請が見つかりません（期限が切れたかもしれません）');
        }
        return json({
            code,
            hostName: row.host_name,
            status: row.status,
            // 承認・拒否したのが自分か（ほかの人が先に承認していたら、画面で知らせる）
            answeredByMe: row.user_id === null ? null : row.user_id === user.userId,
            expiresAt: row.expires_at,
        });
    }
    if (path === '/pair/reject') {
        const res = await env.DB.prepare(
            `UPDATE pairing_requests SET status = 'rejected', user_id = ?
             WHERE code_hash = ? AND status = 'pending' AND expires_at > ?`,
        )
            .bind(user.userId, codeHash, now)
            .run();
        return res.meta.changes ? json({ ok: true }) : error(404, '登録の申請が見つかりません');
    }
    // ホストは 1 人 MAX_HOSTS_PER_USER 台まで（#166。トンネルと DNS のレコードを際限なく作らせない）
    const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM hosts WHERE user_id = ?')
        .bind(user.userId)
        .first<{ n: number }>();
    if ((owned?.n ?? 0) >= MAX_HOSTS_PER_USER) {
        return error(409, `ホストは ${MAX_HOSTS_PER_USER} 台まで登録できます。使っていないホストを外してください`);
    }
    // 承認: hosts に入れて、申請を承認済みにする（同じトランザクション。台数の確かめも同じ文で、同時の承認でも超えない）
    const relayKey = randomToken(32);
    const [inserted] = await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO hosts (id, user_id, name, public_key, relay_key, created_at)
             SELECT host_id, ?1, host_name, public_key, ?2, ?3 FROM pairing_requests
             WHERE code_hash = ?4 AND status = 'pending' AND expires_at > ?3
               AND NOT EXISTS (SELECT 1 FROM hosts WHERE hosts.id = pairing_requests.host_id)
               AND (SELECT COUNT(*) FROM hosts WHERE hosts.user_id = ?1) < ?5`,
        ).bind(user.userId, relayKey, now, codeHash, MAX_HOSTS_PER_USER),
        env.DB.prepare(
            `UPDATE pairing_requests SET status = 'approved', user_id = ?1
             WHERE code_hash = ?2 AND status = 'pending' AND expires_at > ?3
               AND EXISTS (SELECT 1 FROM hosts WHERE hosts.id = pairing_requests.host_id AND hosts.user_id = ?1
                           AND hosts.public_key = pairing_requests.public_key)`,
        ).bind(user.userId, codeHash, now),
    ]);
    if (!inserted.meta.changes) {
        // 同時の承認で台数の上限に当たったのか、申請がなかったのかを分けて返す
        const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM hosts WHERE user_id = ?')
            .bind(user.userId)
            .first<{ n: number }>();
        if ((after?.n ?? 0) >= MAX_HOSTS_PER_USER) {
            return error(409, `ホストは ${MAX_HOSTS_PER_USER} 台まで登録できます。使っていないホストを外してください`);
        }
        return error(404, '登録の申請が見つかりません');
    }
    const host = await env.DB.prepare('SELECT host_id, host_name FROM pairing_requests WHERE code_hash = ?')
        .bind(codeHash)
        .first<{ host_id: string; host_name: string }>();
    return json({ ok: true, hostId: host?.host_id, hostName: host?.host_name });
}
