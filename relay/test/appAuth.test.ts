// iOS アプリのログイン（#441）。システムのログイン画面 → 一度だけのコード（PKCE）→ トークン → API・チケット
// プロバイダの API とホストのトンネルは偽物に差し替える
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_CALLBACK, takeTicket } from '../src/appAuth';
import { base64url, randomToken, sha256 } from '../src/http';

const ORIGIN = 'https://rw-dev.example';
const APP = 'capacitor://localhost';
const EVIL = 'https://evil.example';
const RELAY_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const RECORDING = '/api/projects/p-abc123/sessions/20261009-143012/recording';

// 偽のプロバイダ（コードごとに返す GitHub のユーザー）と、ホストのトンネル
const githubUsers: Record<string, string> = {};
let forwarded: Request[] = [];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    forwarded = [];
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input as RequestInfo, init);
        const url = new URL(req.url);
        if (url.hostname.startsWith('rwt-')) {
            forwarded.push(req);
            if (req.headers.get('Upgrade') === 'websocket') {
                const pair = new WebSocketPair();
                pair[1].accept();
                return new Response(null, { status: 101, webSocket: pair[0] });
            }
            if (url.pathname.endsWith('/recording')) {
                return new Response('part', { status: 206, headers: { 'Content-Type': 'audio/mp4' } });
            }
            return Response.json({ ok: true });
        }
        if (url.pathname === '/login/oauth/access_token') {
            const code = new URLSearchParams(await req.text()).get('code') ?? '';
            return githubUsers[code]
                ? Response.json({ access_token: `token-${code}` })
                : new Response('', { status: 400 });
        }
        const code = (req.headers.get('Authorization') ?? '').replace('Bearer token-', '');
        const subject = githubUsers[code];
        if (!subject) {
            return new Response('unauthorized', { status: 401 });
        }
        return Response.json({ id: Number(subject), login: `u${subject}`, name: `u${subject}`, email: null });
    });
});
afterEach(() => {
    spy.mockRestore();
});

async function pkce() {
    const verifier = randomToken(48);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge, state: randomToken(16) };
}

function appLoginUrl(p: { challenge: string; state: string }, extra = '') {
    return `${ORIGIN}/auth/app/login/github?challenge=${p.challenge}&challenge_method=S256&state=${p.state}${extra}`;
}

// システムのログイン画面の中の流れ。アプリに戻る URL（remotewhisper://auth/callback?...）を返す
async function appLogin(subject: string, p: { challenge: string; state: string }) {
    const start = await SELF.fetch(appLoginUrl(p), { redirect: 'manual' });
    expect(start.status).toBe(302);
    const stateCookie = (start.headers.get('Set-Cookie') ?? '').split(';')[0];
    const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
    const code = `c${crypto.randomUUID()}`;
    githubUsers[code] = subject;
    const back = await SELF.fetch(`${ORIGIN}/auth/callback/github?state=${state}&code=${code}`, {
        redirect: 'manual',
        headers: { Cookie: stateCookie },
    });
    return back;
}

function token(body: unknown, origin?: string) {
    return SELF.fetch(`${ORIGIN}/auth/app/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
    });
}

type Tokens = { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number };

// ログインしてトークンまで。subject は GitHub の ID（同じなら同じユーザー）
async function appTokens(subject = String(Math.floor(Math.random() * 1e9))) {
    const p = await pkce();
    const back = await appLogin(subject, p);
    const code = new URL(back.headers.get('Location') ?? '').searchParams.get('code');
    const res = await token({
        grantType: 'authorization_code',
        code,
        codeVerifier: p.verifier,
        deviceName: 'たろうの iPhone',
    });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as Tokens;
    const row = await env.DB.prepare('SELECT user_id FROM app_sessions WHERE access_hash = ?')
        .bind(await sha256(tokens.accessToken))
        .first<{ user_id: string }>();
    return { ...tokens, userId: row!.user_id };
}

function bearer(
    path: string,
    accessToken: string,
    init: { method?: string; origin?: string | null; body?: unknown; cookie?: string } = {},
) {
    const origin = init.origin === undefined ? APP : init.origin;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (origin) {
        headers.Origin = origin;
    }
    if (init.cookie) {
        headers.Cookie = init.cookie;
    }
    if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'manual',
    });
}

async function newCookie(userId: string) {
    const value = randomToken();
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
        .bind(crypto.randomUUID(), userId, await sha256(value), now, now + 3_600_000, now)
        .run();
    return `__Host-rw_session=${value}`;
}

async function newHost(userId: string) {
    const hostId = crypto.randomUUID();
    await env.DB.prepare(
        'INSERT INTO hosts (id, user_id, name, public_key, relay_key, tunnel_hostname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
        .bind(
            hostId,
            userId,
            'PC',
            'pk',
            RELAY_KEY,
            `rwt-${hostId.replace(/-/g, '').slice(0, 12)}.example.dev`,
            Date.now(),
        )
        .run();
    return hostId;
}

async function ticket(accessToken: string, body: unknown) {
    return bearer('/me/tickets', accessToken, { method: 'POST', body });
}

describe('ログイン（システムのログイン画面）', () => {
    it('Cookie のログインセッションを作らず、一度だけのコードを付けてアプリへ戻す', async () => {
        const p = await pkce();
        const back = await appLogin('101', p);
        expect(back.status).toBe(302);
        const to = new URL(back.headers.get('Location') ?? '');
        expect(`${to.protocol}//${to.host}${to.pathname}`).toBe(APP_CALLBACK);
        expect(to.searchParams.get('state')).toBe(p.state);
        const code = to.searchParams.get('code') ?? '';
        expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // state の Cookie を消すだけで、ログインセッションの Cookie は置かない
        expect(back.headers.get('Set-Cookie') ?? '').not.toContain('__Host-rw_session');
        // D1 にはハッシュだけ
        const rows = await env.DB.prepare('SELECT code_hash, code_challenge FROM app_auth_codes').all<{
            code_hash: string;
            code_challenge: string;
        }>();
        expect(rows.results.some((r) => r.code_hash === code)).toBe(false);
        const hash = await sha256(code);
        expect(rows.results.some((r) => r.code_hash === hash && r.code_challenge === p.challenge)).toBe(true);
    });

    it('プロバイダの画面で断ったら、error を付けてアプリへ戻す', async () => {
        const p = await pkce();
        const start = await SELF.fetch(appLoginUrl(p), { redirect: 'manual' });
        const stateCookie = (start.headers.get('Set-Cookie') ?? '').split(';')[0];
        const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
        const back = await SELF.fetch(`${ORIGIN}/auth/callback/github?state=${state}&error=access_denied`, {
            redirect: 'manual',
            headers: { Cookie: stateCookie },
        });
        expect(back.status).toBe(302);
        expect(back.headers.get('Location')).toBe(`${APP_CALLBACK}?error=access_denied&state=${p.state}`);
    });

    it('始めたのと違うブラウザのコールバックは、今まで通り断る（ログイン CSRF）', async () => {
        const p = await pkce();
        const start = await SELF.fetch(appLoginUrl(p), { redirect: 'manual' });
        const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
        githubUsers.x1 = '102';
        const back = await SELF.fetch(`${ORIGIN}/auth/callback/github?state=${state}&code=x1`, { redirect: 'manual' });
        expect(back.status).toBe(400);
    });

    it('形の違う challenge・state、S256 でないもの、手段を足す（link）ものは断る', async () => {
        const p = await pkce();
        for (const url of [
            `${ORIGIN}/auth/app/login/github?challenge=short&challenge_method=S256&state=${p.state}`,
            `${ORIGIN}/auth/app/login/github?challenge=${p.challenge}&challenge_method=plain&state=${p.state}`,
            `${ORIGIN}/auth/app/login/github?challenge=${p.challenge}&state=${p.state}`,
            `${ORIGIN}/auth/app/login/github?challenge=${p.challenge}&challenge_method=S256&state=x`,
            appLoginUrl(p, '&link=1'),
        ]) {
            expect((await SELF.fetch(url, { redirect: 'manual' })).status, url).toBe(400);
        }
        expect((await SELF.fetch(`${ORIGIN}/auth/app/login/nope?challenge=${p.challenge}`)).status).toBe(404);
    });

    it('アプリのログインだけ、毎回アカウントを選ぶ（同意する）画面を出させる', async () => {
        const p = await pkce();
        for (const [provider, prompt] of [
            ['google', 'select_account'],
            ['discord', 'consent'],
            ['github', 'select_account'],
        ]) {
            const app = await SELF.fetch(appLoginUrl(p).replace('/github?', `/${provider}?`), { redirect: 'manual' });
            expect(new URL(app.headers.get('Location') ?? '').searchParams.get('prompt'), provider).toBe(prompt);
            // ブラウザのログインは今まで通り付けない
            const web = await SELF.fetch(`${ORIGIN}/auth/login/${provider}`, { redirect: 'manual' });
            expect(new URL(web.headers.get('Location') ?? '').searchParams.has('prompt'), provider).toBe(false);
        }
    });
});

describe('コードをトークンに替える', () => {
    it('verifier が合えばトークンを返し、コードは一度しか使えない', async () => {
        const p = await pkce();
        const code = new URL((await appLogin('201', p)).headers.get('Location') ?? '').searchParams.get('code');
        const res = await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier });
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const t = (await res.json()) as Tokens;
        expect(t.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(t.refreshToken).not.toBe(t.accessToken);
        expect(t.accessExpiresAt).toBeGreaterThan(Date.now());
        expect(t.refreshExpiresAt).toBeGreaterThan(t.accessExpiresAt);
        const again = await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier });
        expect(again.status).toBe(400);
        // DB にはハッシュだけ。名前がなければ既定の名前
        const row = await env.DB.prepare('SELECT name, access_hash FROM app_sessions WHERE access_hash = ?')
            .bind(await sha256(t.accessToken))
            .first<{ name: string }>();
        expect(row?.name).toBe('iOS アプリ');
    });

    it('verifier が違えば断り、そのコードはもう使えない（横取りしたコードだけでは替えられない）', async () => {
        const p = await pkce();
        const code = new URL((await appLogin('202', p)).headers.get('Location') ?? '').searchParams.get('code');
        const other = await pkce();
        expect((await token({ grantType: 'authorization_code', code, codeVerifier: other.verifier })).status).toBe(400);
        expect((await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier })).status).toBe(400);
    });

    it('期限の切れたコードは使えない', async () => {
        const p = await pkce();
        const code = new URL((await appLogin('203', p)).headers.get('Location') ?? '').searchParams.get('code') ?? '';
        await env.DB.prepare('UPDATE app_auth_codes SET expires_at = 1 WHERE code_hash = ?')
            .bind(await sha256(code))
            .run();
        expect((await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier })).status).toBe(400);
    });

    it('ほかのサイトの画面からは受けない。形の違うものは断る', async () => {
        const p = await pkce();
        const code = new URL((await appLogin('204', p)).headers.get('Location') ?? '').searchParams.get('code');
        expect((await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier }, EVIL)).status).toBe(
            403,
        );
        expect((await token({ grantType: 'password' })).status).toBe(400);
        expect((await token({ grantType: 'authorization_code', code: 'x', codeVerifier: 'y' })).status).toBe(400);
        // アプリの画面のオリジンからは受ける（コードはまだ使っていない）
        expect((await token({ grantType: 'authorization_code', code, codeVerifier: p.verifier }, APP)).status).toBe(
            200,
        );
    });

    it('同じユーザーの端末は 20 台まで（いちばん長く使っていないものから消す）', async () => {
        const first = await appTokens('205');
        await env.DB.prepare('UPDATE app_sessions SET last_seen_at = 1 WHERE access_hash = ?')
            .bind(await sha256(first.accessToken))
            .run();
        for (let i = 0; i < 20; i++) {
            await appTokens('205');
        }
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id = ?')
            .bind(first.userId)
            .first<{ n: number }>();
        expect(n?.n).toBe(20);
        expect((await bearer('/me', first.accessToken)).status).toBe(401);
    });
});

describe('アクセストークン', () => {
    it('アプリの画面・自分のオリジン・Origin なしからは使える。CORS は資格情報なし', async () => {
        const t = await appTokens();
        const res = await bearer('/me', t.accessToken);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { id: string }).id).toBe(t.userId);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
        expect((await bearer('/me', t.accessToken, { origin: ORIGIN })).status).toBe(200);
        expect((await bearer('/me', t.accessToken, { origin: null })).status).toBe(200);
    });

    it('ほかのサイトの画面からは使えない', async () => {
        const t = await appTokens();
        for (const origin of [EVIL, 'capacitor://evil', 'ionic://localhost']) {
            expect((await bearer('/me', t.accessToken, { origin })).status, origin).toBe(401);
        }
    });

    it('トークンが違えば、Cookie があってもログインしていない扱い（Cookie に戻らない）', async () => {
        const t = await appTokens();
        const cookie = await newCookie(t.userId);
        expect((await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).status).toBe(200);
        expect((await bearer('/me', 'A'.repeat(43), { origin: ORIGIN, cookie })).status).toBe(401);
        expect((await bearer('/me', 'short', { origin: ORIGIN, cookie })).status).toBe(401);
    });

    it('アプリの画面のオリジンでも、トークンがなければ今まで通り Cookie を読まない', async () => {
        const t = await appTokens();
        const cookie = await newCookie(t.userId);
        const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Origin: APP, Cookie: cookie } });
        expect(res.status).toBe(401);
    });

    it('期限が切れたら使えない', async () => {
        const t = await appTokens();
        await env.DB.prepare('UPDATE app_sessions SET access_expires_at = 1 WHERE access_hash = ?')
            .bind(await sha256(t.accessToken))
            .run();
        expect((await bearer('/me', t.accessToken)).status).toBe(401);
    });

    it('状態を変えるもの（Cookie なら同じオリジンだけ）も、アプリの画面から通る', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const res = await bearer(`/me/hosts/${hostId}`, t.accessToken, {
            method: 'PATCH',
            body: { name: '新しい名前' },
        });
        expect(res.status).toBe(200);
        // Cookie はアプリの画面のオリジンからでは、今まで通り通らない
        const cookie = await newCookie(t.userId);
        const viaCookie = await SELF.fetch(`${ORIGIN}/me/hosts/${hostId}`, {
            method: 'PATCH',
            headers: { Cookie: cookie, Origin: APP, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x' }),
        });
        expect(viaCookie.status).toBe(401);
    });
});

describe('更新とログアウト', () => {
    it('更新すると両方のトークンが替わり、前のものは使えなくなる', async () => {
        const t = await appTokens();
        const res = await token({ grantType: 'refresh_token', refreshToken: t.refreshToken });
        expect(res.status).toBe(200);
        const next = (await res.json()) as Tokens;
        expect(next.accessToken).not.toBe(t.accessToken);
        expect(next.refreshToken).not.toBe(t.refreshToken);
        expect((await bearer('/me', t.accessToken)).status).toBe(401);
        expect((await bearer('/me', next.accessToken)).status).toBe(200);
        expect((await token({ grantType: 'refresh_token', refreshToken: t.refreshToken })).status).toBe(401);
        // アクセストークンでは更新できない
        expect((await token({ grantType: 'refresh_token', refreshToken: next.accessToken })).status).toBe(401);
    });

    it('更新トークンの期限が切れたら更新できない', async () => {
        const t = await appTokens();
        await env.DB.prepare('UPDATE app_sessions SET expires_at = 1 WHERE refresh_hash = ?')
            .bind(await sha256(t.refreshToken))
            .run();
        expect((await token({ grantType: 'refresh_token', refreshToken: t.refreshToken })).status).toBe(401);
    });

    it('ログアウトでその端末だけを消す', async () => {
        const a = await appTokens('301');
        const b = await appTokens('301');
        const res = await SELF.fetch(`${ORIGIN}/auth/app/logout`, {
            method: 'POST',
            body: JSON.stringify({ refreshToken: a.refreshToken }),
        });
        expect(res.status).toBe(200);
        expect((await bearer('/me', a.accessToken)).status).toBe(401);
        expect((await token({ grantType: 'refresh_token', refreshToken: a.refreshToken })).status).toBe(401);
        expect((await bearer('/me', b.accessToken)).status).toBe(200);
    });

    it('すべての端末からログアウトすると、アプリの端末も消える', async () => {
        const t = await appTokens('302');
        const cookie = await newCookie(t.userId);
        const res = await SELF.fetch(`${ORIGIN}/me/sessions`, {
            method: 'DELETE',
            headers: { Cookie: cookie, Origin: ORIGIN },
        });
        expect(res.status).toBe(200);
        expect((await bearer('/me', t.accessToken)).status).toBe(401);
    });

    it('ログイン手段を外すと、今の端末以外を消す（アプリの端末から外したときは、その端末を残す）', async () => {
        const a = await appTokens('303');
        const b = await appTokens('303');
        const cookie = await newCookie(a.userId);
        await env.DB.prepare(
            "INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, 'google', ?, ?)",
        )
            .bind('id-303', a.userId, 'g303', Date.now())
            .run();
        const res = await bearer('/me/identities/id-303', a.accessToken, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect((await bearer('/me', a.accessToken)).status).toBe(200);
        expect((await bearer('/me', b.accessToken)).status).toBe(401);
        expect((await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).status).toBe(401);
    });
});

describe('端末の一覧', () => {
    it('一覧を返し、消した端末のトークンはすぐ使えなくなる。Cookie のログインからも消せる', async () => {
        const a = await appTokens('401');
        const b = await appTokens('401');
        const res = await bearer('/me/devices', a.accessToken);
        const { devices } = (await res.json()) as { devices: { id: string; name: string; current: boolean }[] };
        expect(devices).toHaveLength(2);
        expect(devices.filter((d) => d.current)).toHaveLength(1);
        expect(devices[0].name).toBe('たろうの iPhone');
        const other = devices.find((d) => !d.current)!;
        const cookie = await newCookie(a.userId);
        // Cookie はいつも通り、同じオリジンの画面からだけ
        expect(
            (
                await SELF.fetch(`${ORIGIN}/me/devices/${other.id}`, {
                    method: 'DELETE',
                    headers: { Cookie: cookie, Origin: EVIL },
                })
            ).status,
        ).toBe(403);
        const removed = await SELF.fetch(`${ORIGIN}/me/devices/${other.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie, Origin: ORIGIN },
        });
        expect(removed.status).toBe(200);
        expect(((await removed.json()) as { devices: unknown[] }).devices).toHaveLength(1);
        expect((await bearer('/me', b.accessToken)).status).toBe(401);
        expect((await bearer('/me', a.accessToken)).status).toBe(200);
    });

    it('ほかの人の端末は消せない', async () => {
        const a = await appTokens('402');
        const b = await appTokens('403');
        const id = (await env.DB.prepare('SELECT id FROM app_sessions WHERE access_hash = ?')
            .bind(await sha256(b.accessToken))
            .first<{ id: string }>())!.id;
        expect((await bearer(`/me/devices/${id}`, a.accessToken, { method: 'DELETE' })).status).toBe(404);
        expect((await bearer('/me', b.accessToken)).status).toBe(200);
    });
});

describe('ホストへの中継', () => {
    it('トークンで中継し、ホストには Authorization を渡さず署名だけを付ける', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const res = await bearer(`/h/${hostId}/api/projects`, t.accessToken, { method: 'POST', body: {} });
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0].headers.get('Authorization')).toBeNull();
        expect(forwarded[0].headers.get('X-RW-Relay')).toContain(`user=${t.userId}`);
    });

    it('ほかの人のホストには届かない', async () => {
        const t = await appTokens();
        const other = await appTokens();
        const hostId = await newHost(other.userId);
        expect((await bearer(`/h/${hostId}/api/projects`, t.accessToken)).status).toBe(403);
        expect(forwarded).toHaveLength(0);
    });
});

describe('チケット（WebSocket・音声）', () => {
    it('Cookie のログインでは作れない。形の違うもの・ほかの人のホストは断る', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const cookie = await newCookie(t.userId);
        const viaCookie = await SELF.fetch(`${ORIGIN}/me/tickets`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostId, kind: 'ws', path: '/ws' }),
        });
        expect(viaCookie.status).toBe(403);
        for (const body of [
            { hostId, kind: 'ws', path: '/api/projects' },
            { hostId, kind: 'media', path: '/api/projects' },
            { hostId, kind: 'media', path: `${RECORDING}/../x` },
            { hostId, kind: 'other', path: '/ws' },
            { hostId: 'x', kind: 'ws', path: '/ws' },
        ]) {
            expect((await ticket(t.accessToken, body)).status, JSON.stringify(body)).toBe(400);
        }
        const other = await appTokens();
        const otherHost = await newHost(other.userId);
        expect((await ticket(t.accessToken, { hostId: otherHost, kind: 'ws', path: '/ws' })).status).toBe(403);
    });

    it('WebSocket は一度だけ。チケットはホストに渡さず、署名にも入れない', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const res = await ticket(t.accessToken, { hostId, kind: 'ws', path: '/ws' });
        expect(res.status).toBe(200);
        const { ticket: value, expiresAt } = (await res.json()) as { ticket: string; expiresAt: number };
        expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
        const ws = () =>
            SELF.fetch(`${ORIGIN}/h/${hostId}/ws?rw_ticket=${value}`, {
                headers: { Upgrade: 'websocket', Origin: APP },
            });
        const first = await ws();
        expect(first.status).toBe(101);
        first.webSocket?.accept();
        first.webSocket?.close();
        expect(forwarded).toHaveLength(1);
        expect(new URL(forwarded[0].url).search).toBe('');
        expect(forwarded[0].headers.get('X-RW-Relay')).toContain(`user=${t.userId}`);
        expect((await ws()).status).toBe(401);
    });

    it('WebSocket のチケットは、ほかのサイトの画面・ほかのホスト・API では使えない', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const otherHost = await newHost(t.userId);
        const issue = async () =>
            ((await (await ticket(t.accessToken, { hostId, kind: 'ws', path: '/ws' })).json()) as { ticket: string })
                .ticket;
        const evil = await issue();
        expect(
            (
                await SELF.fetch(`${ORIGIN}/h/${hostId}/ws?rw_ticket=${evil}`, {
                    headers: { Upgrade: 'websocket', Origin: EVIL },
                })
            ).status,
        ).toBe(401);
        const wrongHost = await issue();
        expect(
            (
                await SELF.fetch(`${ORIGIN}/h/${otherHost}/ws?rw_ticket=${wrongHost}`, {
                    headers: { Upgrade: 'websocket', Origin: APP },
                })
            ).status,
        ).toBe(401);
        const asApi = await issue();
        expect(
            (await SELF.fetch(`${ORIGIN}/h/${hostId}/api/projects?rw_ticket=${asApi}`, { headers: { Origin: APP } }))
                .status,
        ).toBe(401);
        expect(forwarded).toHaveLength(0);
    });

    it('音声は、作ったときのパスの GET だけ。期限まで何度でも。ほかのクエリはそのまま渡す', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const res = await ticket(t.accessToken, { hostId, kind: 'media', path: RECORDING });
        const { ticket: value } = (await res.json()) as { ticket: string };
        for (let i = 0; i < 2; i++) {
            const got = await SELF.fetch(`${ORIGIN}/h/${hostId}${RECORDING}?source=2&rw_ticket=${value}`, {
                headers: { Range: 'bytes=5-8' },
            });
            expect(got.status).toBe(206);
        }
        expect(new URL(forwarded[0].url).search).toBe('?source=2');
        const other = RECORDING.replace('20261009-143012', '20261010-000000');
        expect((await SELF.fetch(`${ORIGIN}/h/${hostId}${other}?rw_ticket=${value}`)).status).toBe(401);
        expect(
            (
                await SELF.fetch(`${ORIGIN}/h/${hostId}${RECORDING}?rw_ticket=${value}`, {
                    method: 'POST',
                    headers: { Origin: APP },
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await SELF.fetch(`${ORIGIN}/h/${hostId}/ws?rw_ticket=${value}`, {
                    headers: { Upgrade: 'websocket', Origin: APP },
                })
            ).status,
        ).toBe(401);
    });

    it('端末を消すと、その端末のチケットも使えない。違うチケットは Cookie があっても通さない', async () => {
        const t = await appTokens();
        const hostId = await newHost(t.userId);
        const { ticket: value } = (await (
            await ticket(t.accessToken, { hostId, kind: 'media', path: RECORDING })
        ).json()) as {
            ticket: string;
        };
        const cookie = await newCookie(t.userId);
        expect(
            (
                await SELF.fetch(`${ORIGIN}/h/${hostId}${RECORDING}?rw_ticket=${'A'.repeat(43)}`, {
                    headers: { Cookie: cookie },
                })
            ).status,
        ).toBe(401);
        await SELF.fetch(`${ORIGIN}/auth/app/logout`, {
            method: 'POST',
            body: JSON.stringify({ refreshToken: t.refreshToken }),
        });
        expect((await SELF.fetch(`${ORIGIN}/h/${hostId}${RECORDING}?rw_ticket=${value}`)).status).toBe(401);
    });

    it('クエリからチケットだけを取り出す（ほかの書き方は変えない）', () => {
        expect(takeTicket('')).toEqual({ ticket: null, rest: '' });
        expect(takeTicket('?a=%20b&c')).toEqual({ ticket: null, rest: '?a=%20b&c' });
        expect(takeTicket('?a=%20b&rw_ticket=xyz&c')).toEqual({ ticket: 'xyz', rest: '?a=%20b&c' });
        expect(takeTicket('?rw_ticket=xyz')).toEqual({ ticket: 'xyz', rest: '' });
        expect(takeTicket('?rw_ticket=a&rw_ticket=b')).toEqual({ ticket: '', rest: '' });
    });
});
