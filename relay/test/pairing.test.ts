// ホストの登録（#157）。ホスト側の署名は、トレイ（server/src/remote_whisper/cloud.py）と同じ組み立て方
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { base64url, sha256 } from '../src/http';
import { normalizeCode, parseHostHeader } from '../src/pairing';

const ORIGIN = 'https://rw-dev.example';

type Host = { hostId: string; keys: CryptoKeyPair; publicKey: string; ip: string };

async function newHost(): Promise<Host> {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer;
    return {
        hostId: crypto.randomUUID(),
        keys,
        publicKey: base64url(raw),
        ip: `198.51.100.${Math.floor(Math.random() * 250)}`,
    };
}

async function hex(body: string) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signHeader(host: Host, path: string, body: string, opts: { ts?: number; key?: CryptoKey } = {}) {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const message = ['v1', host.hostId, String(ts), 'POST', path, await hex(body)].join('\n');
    const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        opts.key ?? host.keys.privateKey,
        new TextEncoder().encode(message),
    );
    return `v1;host=${host.hostId};ts=${ts};sig=${base64url(sig)}`;
}

async function hostCall(
    host: Host,
    path: string,
    payload: object,
    opts: { ts?: number; key?: CryptoKey; header?: string | null } = {},
) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': host.ip };
    const header = opts.header === undefined ? await signHeader(host, path, body, opts) : opts.header;
    if (header !== null) {
        headers['X-RW-Host'] = header;
    }
    return SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body });
}

async function startPairing(host: Host) {
    const res = await hostCall(host, '/pair/start', {
        hostId: host.hostId,
        hostName: 'TEST-PC',
        publicKey: host.publicKey,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { code: string; url: string; expiresInSec: number };
}

const poll = (host: Host, opts = {}) => hostCall(host, '/pair/poll', {}, opts);

// ログインしているユーザー（D1 に直接作る）。Cookie を返す
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

function browser(cookie: string, path: string, init: { method?: string; body?: object; origin?: string | null } = {}) {
    const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': 'application/json' };
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (origin) {
        headers.Origin = origin;
    }
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
    });
}

const approve = (cookie: string, code: string, origin?: string | null) =>
    browser(cookie, '/pair/approve', { method: 'POST', body: { code }, origin });

async function hostRow(hostId: string) {
    return env.DB.prepare('SELECT user_id, relay_key FROM hosts WHERE id = ?')
        .bind(hostId)
        .first<{ user_id: string; relay_key: string }>();
}

describe('登録コード', () => {
    it('XXXX-XXXX の形にそろえる', () => {
        expect(normalizeCode('abcd efgh')).toBe('ABCD-EFGH');
        expect(normalizeCode('ABCD-EFGH')).toBe('ABCD-EFGH');
        // 0・O・1・I は使わない
        expect(normalizeCode('ABCD-EFG0')).toBeNull();
        expect(normalizeCode('ABC')).toBeNull();
        expect(normalizeCode(null)).toBeNull();
    });

    it('X-RW-Host は 4 項目ちょうど、この順だけ', async () => {
        const host = await newHost();
        const good = await signHeader(host, '/pair/poll', '{}');
        expect(parseHostHeader(good)?.hostId).toBe(host.hostId);
        const [, h, t, s] = good.split(';');
        for (const bad of [
            `v1;${h};${h};${t};${s}`,
            `v1;${h};${t};${s};x=1`,
            `v1;${t};${h};${s}`,
            `v2;${h};${t};${s}`,
            `v1;host=;${t};${s}`,
            '',
        ]) {
            expect(parseHostHeader(bad)).toBeNull();
        }
    });
});

describe('登録の流れ', () => {
    it('申請 → 承認 → ポーリングで中継の鍵。期限までは何度聞いても同じ鍵', async () => {
        const host = await newHost();
        const ticket = await startPairing(host);
        expect(ticket.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        expect(ticket.url).toBe(`${ORIGIN}/pair?code=${ticket.code}`);
        expect(ticket.expiresInSec).toBe(600);
        // DB にはコードのハッシュだけ
        const stored = await env.DB.prepare('SELECT code_hash FROM pairing_requests WHERE host_id = ?')
            .bind(host.hostId)
            .first<{ code_hash: string }>();
        expect(stored?.code_hash).toBe(await sha256(ticket.code));

        expect(await (await poll(host)).json()).toEqual({ status: 'pending' });

        const { userId, cookie } = await newUser();
        const info = await browser(cookie, `/pair/request?code=${ticket.code.toLowerCase()}`);
        expect(await info.json()).toMatchObject({ code: ticket.code, hostName: 'TEST-PC', status: 'pending' });
        const ok = await approve(cookie, ticket.code);
        expect(await ok.json()).toEqual({ ok: true, hostId: host.hostId, hostName: 'TEST-PC' });
        // 承認したときに hosts に入る
        const row = await hostRow(host.hostId);
        expect(row?.user_id).toBe(userId);

        await env.DB.prepare('UPDATE pairing_requests SET last_polled_at = 0 WHERE host_id = ?')
            .bind(host.hostId)
            .run();
        const first = (await (await poll(host)).json()) as { status: string; relayKey: string };
        expect(first).toEqual({ status: 'approved', relayKey: row?.relay_key });
        await env.DB.prepare('UPDATE pairing_requests SET last_polled_at = 0 WHERE host_id = ?')
            .bind(host.hostId)
            .run();
        expect(await (await poll(host)).json()).toEqual(first);

        // 自分のホストの一覧に出る（鍵は出さない）
        const list = (await (await browser(cookie, '/me/hosts')).json()) as { hosts: Record<string, unknown>[] };
        expect(list.hosts).toHaveLength(1);
        expect(list.hosts[0]).toMatchObject({ id: host.hostId, name: 'TEST-PC' });
        expect(JSON.stringify(list)).not.toContain(first.relayKey);
    });

    it('拒否したものは登録にならない', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        const res = await browser(cookie, '/pair/reject', { method: 'POST', body: { code } });
        expect(res.status).toBe(200);
        expect(await (await poll(host)).json()).toEqual({ status: 'rejected' });
        expect((await approve(cookie, code)).status).toBe(404);
        expect(await hostRow(host.hostId)).toBeNull();
    });

    it('期限が切れたものは登録にならない', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        await env.DB.prepare('UPDATE pairing_requests SET expires_at = ? WHERE host_id = ?')
            .bind(Date.now() - 1, host.hostId)
            .run();
        const { cookie } = await newUser();
        expect((await browser(cookie, `/pair/request?code=${code}`)).status).toBe(404);
        expect((await approve(cookie, code)).status).toBe(404);
        expect((await poll(host)).status).toBe(404);
        expect(await hostRow(host.hostId)).toBeNull();
    });

    it('コードの使い回し（承認済みのものをほかの人が承認）は登録にならない', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        const alice = await newUser();
        const bob = await newUser();
        expect((await approve(alice.cookie, code)).status).toBe(200);
        expect((await approve(bob.cookie, code)).status).toBe(404);
        expect((await hostRow(host.hostId))?.user_id).toBe(alice.userId);
    });

    it('承認は、ログインしていて同じオリジンの画面からだけ', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        expect((await approve(cookie, code, 'https://evil.example')).status).toBe(403);
        expect((await approve(cookie, code, null)).status).toBe(403);
        expect((await approve('__Host-rw_session=nope', code)).status).toBe(401);
        expect((await approve(cookie, 'nope')).status).toBe(400);
        expect(await hostRow(host.hostId)).toBeNull();
    });
});

describe('ホストの署名', () => {
    it('署名がない・ほかのホストの鍵・本文が違う・時刻がずれた申請は断る', async () => {
        const host = await newHost();
        const other = await newHost();
        const payload = { hostId: host.hostId, hostName: 'TEST-PC', publicKey: host.publicKey };
        expect((await hostCall(host, '/pair/start', payload, { header: null })).status).toBe(401);
        expect((await hostCall(host, '/pair/start', payload, { key: other.keys.privateKey })).status).toBe(401);
        expect((await hostCall(host, '/pair/start', payload, { ts: Math.floor(Date.now() / 1000) - 120 })).status).toBe(
            401,
        );
        const signedOther = await signHeader(host, '/pair/start', '{}');
        expect((await hostCall(host, '/pair/start', payload, { header: signedOther })).status).toBe(401);
        expect(
            await env.DB.prepare('SELECT 1 FROM pairing_requests WHERE host_id = ?').bind(host.hostId).first(),
        ).toBeNull();
    });

    it('ポーリングは申請した鍵の署名でだけ答える（ほかのホストの鍵では中継の鍵を取れない）', async () => {
        const host = await newHost();
        const other = await newHost();
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        await approve(cookie, code);
        expect((await poll(host, { header: null })).status).toBe(401);
        expect((await poll(host, { key: other.keys.privateKey })).status).toBe(401);
        expect((await poll(host, { ts: Math.floor(Date.now() / 1000) + 120 })).status).toBe(401);
    });

    it('登録済み・申請中のホスト ID での申請は 409（別の鍵での乗っ取りを防ぐ）', async () => {
        const host = await newHost();
        await startPairing(host);
        const thief = await newHost();
        const stolen = { ...thief, hostId: host.hostId };
        const res = await hostCall(stolen, '/pair/start', {
            hostId: host.hostId,
            hostName: 'EVIL',
            publicKey: thief.publicKey,
        });
        expect(res.status).toBe(409);
    });

    it('形の違う申請は 400', async () => {
        const host = await newHost();
        for (const payload of [
            { hostId: 'not-a-uuid', hostName: 'PC', publicKey: host.publicKey },
            { hostId: host.hostId, hostName: '', publicKey: host.publicKey },
            { hostId: host.hostId, hostName: 'x'.repeat(65), publicKey: host.publicKey },
            { hostId: host.hostId, hostName: 'PC', publicKey: 'short' },
        ]) {
            expect((await hostCall(host, '/pair/start', payload)).status).toBe(400);
        }
    });
});

describe('回数の制限', () => {
    it('同じ接続元からの申請は 10 分に 5 回まで', async () => {
        const ip = '203.0.113.77';
        for (let i = 0; i < 5; i++) {
            const host = { ...(await newHost()), ip };
            await startPairing(host);
        }
        const sixth = { ...(await newHost()), ip };
        const res = await hostCall(sixth, '/pair/start', {
            hostId: sixth.hostId,
            hostName: 'PC',
            publicKey: sixth.publicKey,
        });
        expect(res.status).toBe(429);
    });

    it('ポーリングは 1 秒に 1 回まで', async () => {
        const host = await newHost();
        await startPairing(host);
        expect((await poll(host)).status).toBe(200);
        expect((await poll(host)).status).toBe(429);
    });
});

describe('解除', () => {
    it('申請中に /pair/unpair が来たら申請を取り消し、そのあとの承認は断る', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        expect((await hostCall(host, '/pair/unpair', {})).status).toBe(200);
        const { cookie } = await newUser();
        expect((await approve(cookie, code)).status).toBe(404);
        expect(await hostRow(host.hostId)).toBeNull();
        // 行は期限まで残す（申請と取り消しを繰り返して、回数の制限を抜けられないように）
        const row = await env.DB.prepare('SELECT status FROM pairing_requests WHERE host_id = ?')
            .bind(host.hostId)
            .first<{ status: string }>();
        expect(row?.status).toBe('rejected');
    });

    it('ほかの人が先に承認したことが、確認の画面でわかる。PC 名から書式の文字を除く', async () => {
        const host = await newHost();
        const res = await hostCall(host, '/pair/start', {
            hostId: host.hostId,
            hostName: 'MY‮-PC​',
            publicKey: host.publicKey,
        });
        const { code } = (await res.json()) as { code: string };
        const alice = await newUser();
        const bob = await newUser();
        await approve(bob.cookie, code);
        const seenByAlice = await (await browser(alice.cookie, `/pair/request?code=${code}`)).json();
        expect(seenByAlice).toMatchObject({ hostName: 'MY-PC', status: 'approved', answeredByMe: false });
        const seenByBob = await (await browser(bob.cookie, `/pair/request?code=${code}`)).json();
        expect(seenByBob).toMatchObject({ answeredByMe: true });
    });

    it('登録済みのホストは /pair/unpair で消える。ほかの鍵では消せない', async () => {
        const host = await newHost();
        const other = await newHost();
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        await approve(cookie, code);
        expect((await hostCall(host, '/pair/unpair', {}, { key: other.keys.privateKey })).status).toBe(401);
        expect(await hostRow(host.hostId)).not.toBeNull();
        expect((await hostCall(host, '/pair/unpair', {})).status).toBe(200);
        expect(await hostRow(host.hostId)).toBeNull();
        expect((await hostCall(host, '/pair/unpair', {})).status).toBe(404);
    });

    it('画面から外せる（ほかの人のホストは外せない）', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        const alice = await newUser();
        const bob = await newUser();
        await approve(alice.cookie, code);
        expect((await browser(bob.cookie, `/me/hosts/${host.hostId}`, { method: 'DELETE' })).status).toBe(404);
        const res = await browser(alice.cookie, `/me/hosts/${host.hostId}`, { method: 'DELETE' });
        expect(await res.json()).toEqual({ hosts: [] });
        // 外したあとは、ポーリングしても中継の鍵は出ない
        expect((await poll(host)).status).toBe(404);
    });

    it('退会するとホストも消える', async () => {
        const host = await newHost();
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        await approve(cookie, code);
        expect((await browser(cookie, '/me', { method: 'DELETE' })).status).toBe(200);
        expect(await hostRow(host.hostId)).toBeNull();
    });
});
