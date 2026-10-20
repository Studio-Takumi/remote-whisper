// ログイン（#155）。プロバイダの API（トークン・ユーザー情報）は偽物に差し替える
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeReturnTo } from '../src/http';

const ORIGIN = 'https://rw-dev.example';

// 偽のプロバイダ: コードごとに、返すユーザーを決める
const users: Record<string, { subject: string; name: string; email: string | null }> = {};

function fakeProviders() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        // トークンの URL（Google・Discord は /token、GitHub は /access_token）
        if (/\/(access_)?token$/.test(new URL(url).pathname)) {
            const body = new URLSearchParams(String(init?.body));
            const code = body.get('code') ?? '';
            if (!users[code] || !body.get('code_verifier')) {
                return Response.json({ error: 'invalid_grant' }, { status: 400 });
            }
            return Response.json({ access_token: `token-${code}` });
        }
        const auth = new Headers(init?.headers).get('Authorization') ?? '';
        const code = auth.replace('Bearer token-', '');
        const u = users[code];
        if (!u) {
            return new Response('unauthorized', { status: 401 });
        }
        if (url.includes('googleapis')) {
            return Response.json({ sub: u.subject, name: u.name, email: u.email });
        }
        if (url.includes('discord.com')) {
            return Response.json({ id: u.subject, username: u.name, global_name: u.name, email: u.email });
        }
        return Response.json({ id: Number(u.subject), login: u.name, name: u.name, email: u.email });
    });
}

let spy: ReturnType<typeof fakeProviders>;
beforeEach(() => {
    spy = fakeProviders();
});
afterEach(() => {
    spy.mockRestore();
});

async function startLogin(provider: string, query = '', cookie?: string) {
    const res = await SELF.fetch(`${ORIGIN}/auth/login/${provider}${query}`, {
        redirect: 'manual',
        headers: cookie ? { Cookie: cookie } : {},
    });
    return res;
}

// ログインを最後まで進め、ログインセッションの Cookie を返す
async function login(provider: string, code: string, opts: { link?: string; returnTo?: string } = {}) {
    const query = opts.link ? '?link=1' : opts.returnTo ? `?return=${encodeURIComponent(opts.returnTo)}` : '';
    const start = await startLogin(provider, query, opts.link);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
    const cb = await SELF.fetch(`${ORIGIN}/auth/callback/${provider}?state=${state}&code=${code}`, {
        redirect: 'manual',
        headers: opts.link ? { Cookie: opts.link } : {},
    });
    return cb;
}

function cookieOf(res: Response) {
    const set = res.headers.get('Set-Cookie') ?? '';
    return set.split(';')[0];
}

async function me(cookie: string) {
    return SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
}

describe('ログインを始める', () => {
    it('state と PKCE（S256）を付けてプロバイダへ送り、state は D1 にハッシュだけ置く', async () => {
        const res = await startLogin('github', '?return=/s/abc');
        expect(res.status).toBe(302);
        const to = new URL(res.headers.get('Location') ?? '');
        expect(to.origin).toBe('https://github.com');
        expect(to.searchParams.get('client_id')).toBe('github-id');
        expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/github`);
        expect(to.searchParams.get('code_challenge_method')).toBe('S256');
        const state = to.searchParams.get('state') ?? '';
        const rows = await env.DB.prepare('SELECT state_hash, return_to FROM oauth_states').all<{
            state_hash: string;
            return_to: string;
        }>();
        expect(rows.results.some((r) => r.return_to === '/s/abc')).toBe(true);
        expect(rows.results.some((r) => r.state_hash === state)).toBe(false);
    });

    it('知らないプロバイダは 404', async () => {
        expect((await startLogin('twitter')).status).toBe(404);
    });
});

describe('戻ってきたとき', () => {
    it('ユーザーとログイン手段を作り、ログインセッションの Cookie を付けて戻る', async () => {
        users.c1 = { subject: '100', name: 'たろう', email: 'taro@example.com' };
        const res = await login('github', 'c1', { returnTo: '/s/abc' });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/s/abc');
        const set = res.headers.get('Set-Cookie') ?? '';
        expect(set).toMatch(/^__Host-rw_session=/);
        expect(set).toContain('HttpOnly');
        expect(set).toContain('Secure');
        expect(set).toContain('SameSite=Lax');
        const body = (await (await me(cookieOf(res))).json()) as { displayName: string; identities: unknown[] };
        expect(body.displayName).toBe('たろう');
        expect(body.identities).toHaveLength(1);
        // DB にはトークンそのものを置かない
        const token = cookieOf(res).split('=')[1];
        const raw = await env.DB.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE token_hash = ?')
            .bind(token)
            .first<{ n: number }>();
        expect(raw?.n).toBe(0);
    });

    it('同じプロバイダの同じ ID なら、同じユーザー', async () => {
        users.c2 = { subject: '200', name: 'はなこ', email: null };
        const a = (await (await me(cookieOf(await login('discord', 'c2')))).json()) as { id: string };
        const b = (await (await me(cookieOf(await login('discord', 'c2')))).json()) as { id: string };
        expect(a.id).toBe(b.id);
    });

    it('同じメールアドレスでも、別のプロバイダなら別のユーザー（自動に紐付けない）', async () => {
        users.c3 = { subject: '300', name: 'じろう', email: 'same@example.com' };
        users.c4 = { subject: '301', name: 'じろう', email: 'same@example.com' };
        const a = (await (await me(cookieOf(await login('google', 'c3')))).json()) as { id: string };
        const b = (await (await me(cookieOf(await login('github', 'c4')))).json()) as { id: string };
        expect(a.id).not.toBe(b.id);
    });

    it('state の使い回し・ずれ・期限切れ・なしは、どれもログインにならない', async () => {
        users.c5 = { subject: '500', name: 'さぶろう', email: null };
        const start = await startLogin('google');
        const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
        // 別のプロバイダの callback に持っていく
        const wrong = await SELF.fetch(`${ORIGIN}/auth/callback/github?state=${state}&code=c5`, {
            redirect: 'manual',
        });
        expect(wrong.status).toBe(400);
        // 一度使った（ずれでも消える）state は、もう使えない
        const reuse = await SELF.fetch(`${ORIGIN}/auth/callback/google?state=${state}&code=c5`, {
            redirect: 'manual',
        });
        expect(reuse.status).toBe(400);
        // 期限切れ
        const start2 = await startLogin('google');
        const state2 = new URL(start2.headers.get('Location') ?? '').searchParams.get('state');
        await env.DB.prepare('UPDATE oauth_states SET expires_at = 0').run();
        const expired = await SELF.fetch(`${ORIGIN}/auth/callback/google?state=${state2}&code=c5`, {
            redirect: 'manual',
        });
        expect(expired.status).toBe(400);
        // state なし
        const none = await SELF.fetch(`${ORIGIN}/auth/callback/google?code=c5`, { redirect: 'manual' });
        expect(none.status).toBe(400);
    });

    it('プロバイダがコードを受け付けなければ 502 で、ログインにならない', async () => {
        const res = await login('github', 'unknown-code');
        expect(res.status).toBe(502);
        expect(res.headers.get('Set-Cookie')).toBeNull();
    });
});

describe('ログイン手段を足す・外す', () => {
    it('ログインしている人が別の手段を足すと、同じユーザーに付く。最後の 1 つは外せない', async () => {
        users.c6 = { subject: '600', name: 'しろう', email: null };
        users.c7 = { subject: '601', name: 'しろう', email: null };
        const cookie = cookieOf(await login('github', 'c6'));
        const linked = await login('google', 'c7', { link: cookie });
        expect(linked.status).toBe(302);
        // 足しただけ。新しいログインセッションは作らない
        expect(linked.headers.get('Set-Cookie')).toBeNull();
        const body = (await (await me(cookie)).json()) as { identities: { id: string; provider: string }[] };
        expect(body.identities.map((i) => i.provider).sort()).toEqual(['github', 'google']);
        const del = (id: string) =>
            SELF.fetch(`${ORIGIN}/me/identities/${id}`, {
                method: 'DELETE',
                headers: { Cookie: cookie, Origin: ORIGIN },
            });
        expect((await del(body.identities[0].id)).status).toBe(200);
        expect((await del(body.identities[1].id)).status).toBe(409);
    });

    it('ほかのユーザーのログイン手段は、足せない', async () => {
        users.c8 = { subject: '800', name: 'ごろう', email: null };
        users.c9 = { subject: '801', name: 'ろくろう', email: null };
        await login('discord', 'c8');
        const other = cookieOf(await login('github', 'c9'));
        const res = await login('discord', 'c8', { link: other });
        expect(res.status).toBe(409);
    });

    it('ログインしていなければ、足せない', async () => {
        expect((await startLogin('google', '?link=1')).status).toBe(401);
    });
});

describe('ログアウト・退会', () => {
    it('ログアウトは同じオリジンからだけ。したらログインセッションが消える', async () => {
        users.d1 = { subject: '900', name: 'ななこ', email: null };
        const cookie = cookieOf(await login('google', 'd1'));
        const cross = await SELF.fetch(`${ORIGIN}/auth/logout`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: 'https://evil.example' },
        });
        expect(cross.status).toBe(403);
        expect((await me(cookie)).status).toBe(200);
        const out = await SELF.fetch(`${ORIGIN}/auth/logout`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: ORIGIN },
        });
        expect(out.status).toBe(200);
        expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
        expect((await me(cookie)).status).toBe(401);
    });

    it('退会すると、ユーザー・ログイン手段・ログインセッションが消える', async () => {
        users.d2 = { subject: '901', name: 'はちろう', email: null };
        const cookie = cookieOf(await login('github', 'd2'));
        const id = ((await (await me(cookie)).json()) as { id: string }).id;
        const res = await SELF.fetch(`${ORIGIN}/me`, { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } });
        expect(res.status).toBe(200);
        for (const table of ['users', 'auth_identities', 'web_sessions']) {
            const column = table === 'users' ? 'id' : 'user_id';
            const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
                .bind(id)
                .first<{ n: number }>();
            expect(n?.n).toBe(0);
        }
    });

    it('ログインしていなければ /me は 401', async () => {
        expect((await SELF.fetch(`${ORIGIN}/me`)).status).toBe(401);
    });
});

describe('戻る先', () => {
    it('同じオリジンのパスだけ', () => {
        expect(safeReturnTo('/s/abc')).toBe('/s/abc');
        expect(safeReturnTo('//evil.example')).toBe('/');
        expect(safeReturnTo('https://evil.example')).toBe('/');
        expect(safeReturnTo('/\\evil.example')).toBe('/');
        expect(safeReturnTo(null)).toBe('/');
    });
});
