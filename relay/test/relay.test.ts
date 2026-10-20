// ホストへの中継（#160）。トンネルの先（ホスト）は fetch を差し替えて、届いたリクエストを見る
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/http';
import { relayCanonical, signRelay } from '../src/relay';

const ORIGIN = 'https://rw-dev.example';
// 中継の鍵（bytes 0..31 の base64url）。ホスト側（Python）のテストと同じ固定値
const RELAY_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

let forwarded: Request[] = [];
// 転送された本文（Worker の中で読んでおく。テストの側からは読めないため）
let bodies: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    forwarded = [];
    bodies = [];
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input as RequestInfo, init);
        forwarded.push(req);
        bodies.push(['GET', 'HEAD'].includes(req.method) ? '' : await req.clone().text());
        if (req.headers.get('Upgrade') === 'websocket') {
            const pair = new WebSocketPair();
            pair[1].accept();
            return new Response(null, { status: 101, webSocket: pair[0] });
        }
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'evil=1; Path=/', 'X-From-Host': '1' } });
    });
});
afterEach(() => {
    spy.mockRestore();
});

async function newUser() {
    const userId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, 'たろう', now),
        env.DB.prepare(
            'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + 3_600_000, now),
    ]);
    return { userId, cookie: `__Host-rw_session=${token}` };
}

async function newHost(userId: string, opts: { tunnel?: string | null; relayKey?: string | null } = {}) {
    const hostId = crypto.randomUUID();
    const tunnel = opts.tunnel === undefined ? `rwt-${hostId.replace(/-/g, '').slice(0, 12)}.example.dev` : opts.tunnel;
    await env.DB.prepare(
        'INSERT INTO hosts (id, user_id, name, public_key, relay_key, tunnel_hostname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
        .bind(
            hostId,
            userId,
            'TEST-PC',
            'pk',
            opts.relayKey === undefined ? RELAY_KEY : opts.relayKey,
            tunnel,
            Date.now(),
        )
        .run();
    return { hostId, tunnel };
}

function call(
    path: string,
    init: {
        cookie?: string;
        method?: string;
        origin?: string | null;
        headers?: Record<string, string>;
        body?: string;
    } = {},
) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.cookie) {
        headers.Cookie = init.cookie;
    }
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (origin) {
        headers.Origin = origin;
    }
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'manual',
    });
}

describe('署名', () => {
    it('ホスト（Python）と同じ固定値になる', async () => {
        expect(relayCanonical('u-1', 'h', 1, 'get', '/ws')).toBe('v1\nu-1\nh\n1\nGET\n/ws');
        const header = await signRelay(
            RELAY_KEY,
            'u-1',
            '11111111-2222-4333-8444-555555555555',
            1800000000,
            'GET',
            '/api/projects?x=1',
        );
        expect(header).toBe(
            'v1;user=u-1;host=11111111-2222-4333-8444-555555555555;ts=1800000000;sig=sAXwWExaGr2NlUMM5nFRLnVnCvzea-rPM05fI6k4Dso',
        );
    });
});

describe('中継', () => {
    it('自分のホストへ、Cookie などを落とし署名を付けて転送する', async () => {
        const { userId, cookie } = await newUser();
        const { hostId, tunnel } = await newHost(userId);
        const res = await call(`/h/${hostId}/api/projects?x=1`, {
            cookie,
            headers: {
                Authorization: 'Bearer x',
                'X-RW-Relay': 'v1;forged',
                'X-RW-Host': 'forged',
                'CF-Connecting-IP': '203.0.113.1',
                Expect: '100-continue',
                'Accept-Language': 'ja',
            },
        });
        expect(res.status).toBe(200);
        // ホストが置こうとした Cookie は、このオリジンに置かせない
        expect(res.headers.get('Set-Cookie')).toBeNull();
        expect(res.headers.get('X-From-Host')).toBe('1');
        expect(forwarded).toHaveLength(1);
        const req = forwarded[0];
        expect(req.url).toBe(`https://${tunnel}/api/projects?x=1`);
        for (const name of ['Cookie', 'Authorization', 'X-RW-Host', 'CF-Connecting-IP', 'Expect']) {
            expect(req.headers.get(name), name).toBeNull();
        }
        expect(req.headers.get('Accept-Language')).toBe('ja');
        const header = req.headers.get('X-RW-Relay') ?? '';
        const ts = Number(/;ts=(\d+);/.exec(header)?.[1]);
        expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
        expect(header).toBe(await signRelay(RELAY_KEY, userId, hostId, ts, 'GET', '/api/projects?x=1'));
    });

    it('POST は本文もそのまま転送する', async () => {
        const { userId, cookie } = await newUser();
        const { hostId } = await newHost(userId);
        const res = await call(`/h/${hostId}/api/projects`, {
            cookie,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"name":"x"}',
        });
        expect(res.status).toBe(200);
        expect(bodies[0]).toBe('{"name":"x"}');
    });

    it('WebSocket はつなぐときに確かめて、101 をそのまま返す', async () => {
        const { userId, cookie } = await newUser();
        const { hostId, tunnel } = await newHost(userId);
        const res = await call(`/h/${hostId}/ws`, { cookie, headers: { Upgrade: 'websocket' } });
        expect(res.status).toBe(101);
        expect(res.webSocket).toBeTruthy();
        res.webSocket?.accept();
        res.webSocket?.close();
        expect(forwarded[0].url).toBe(`https://${tunnel}/ws`);
        expect(forwarded[0].headers.get('X-RW-Relay')).toMatch(/^v1;user=/);
    });
});

describe('断るもの（どれもホストに届かない）', () => {
    it('ログインしていない', async () => {
        const { userId } = await newUser();
        const { hostId } = await newHost(userId);
        expect((await call(`/h/${hostId}/api/projects`)).status).toBe(401);
        expect(forwarded).toHaveLength(0);
    });

    it('他人のホスト・ないホスト（解除したもの）', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const { hostId } = await newHost(alice.userId);
        expect((await call(`/h/${hostId}/api/projects`, { cookie: bob.cookie })).status).toBe(403);
        await env.DB.prepare('DELETE FROM hosts WHERE id = ?').bind(hostId).run();
        expect((await call(`/h/${hostId}/api/projects`, { cookie: alice.cookie })).status).toBe(403);
        expect(forwarded).toHaveLength(0);
    });

    it('ほかのオリジンからの POST と WebSocket', async () => {
        const { userId, cookie } = await newUser();
        const { hostId } = await newHost(userId);
        const evil = 'https://other.example.dev';
        expect(
            (await call(`/h/${hostId}/api/projects`, { cookie, method: 'POST', origin: evil, body: '{}' })).status,
        ).toBe(403);
        expect(
            (await call(`/h/${hostId}/ws`, { cookie, origin: evil, headers: { Upgrade: 'websocket' } })).status,
        ).toBe(403);
        expect(
            (await call(`/h/${hostId}/ws`, { cookie, origin: null, headers: { Upgrade: 'websocket' } })).status,
        ).toBe(403);
        expect(forwarded).toHaveLength(0);
    });

    it('API と WebSocket 以外のパス・形の違うホスト ID', async () => {
        const { userId, cookie } = await newUser();
        const { hostId } = await newHost(userId);
        for (const path of [`/h/${hostId}/`, `/h/${hostId}/docs`, `/h/${hostId}`, '/h/not-a-uuid/api/x']) {
            expect((await call(path, { cookie })).status, path).toBe(404);
        }
        expect(forwarded).toHaveLength(0);
    });

    it('トンネルや中継の鍵がまだない・トンネルの名前がおかしいホストは 503', async () => {
        const { userId, cookie } = await newUser();
        for (const opts of [{ tunnel: null }, { relayKey: null }, { tunnel: 'evil.example.com' }]) {
            const { hostId } = await newHost(userId, opts);
            expect((await call(`/h/${hostId}/api/projects`, { cookie })).status).toBe(503);
        }
        expect(forwarded).toHaveLength(0);
    });

    it('ホストにつながらなければ 502', async () => {
        const { userId, cookie } = await newUser();
        const { hostId } = await newHost(userId);
        spy.mockRejectedValueOnce(new Error('offline'));
        expect((await call(`/h/${hostId}/api/projects`, { cookie })).status).toBe(502);
    });
});
