// ホストの登録（#157）。ホスト側の署名は、トレイ（server/src/remote_whisper/cloud.py）と同じ組み立て方
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { base64url, sha256 } from '../src/http';
import { CLIENT_HASH_KEY, clientHash, normalizeCode, parseHostHeader } from '../src/pairing';

const ORIGIN = 'https://rw-dev.example';

type Host = { hostId: string; keys: CryptoKeyPair; publicKey: string; ip: string; country?: string };

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
    return SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body, ...cfOf(host.country) });
}

// Cloudflare が付ける request.cf（国だけ）。undefined なら付けない（国がわからないときの形）
function cfOf(country: string | undefined) {
    return country === undefined ? {} : ({ cf: { country } } as unknown as RequestInit);
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

function browser(
    cookie: string,
    path: string,
    init: { method?: string; body?: object; origin?: string | null; ip?: string; country?: string } = {},
) {
    const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': 'application/json' };
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (origin) {
        headers.Origin = origin;
    }
    if (init.ip) {
        headers['CF-Connecting-IP'] = init.ip;
    }
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        ...cfOf(init.country),
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

describe('本文の上限', () => {
    // Content-Length のない（chunked の）本文
    function chunked(bytes: number): Request {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"x":"' + 'x'.repeat(bytes)));
                controller.close();
            },
        });
        return new Request(`${ORIGIN}/pair/start`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    }

    it('上限より大きい chunked の本文は 413', async () => {
        const request = chunked(8192);
        expect(request.headers.get('Content-Length')).toBeNull();
        expect((await SELF.fetch(request)).status).toBe(413);
    });

    it('Content-Length が上限より大きくても 413', async () => {
        const host = await newHost();
        const res = await hostCall(host, '/pair/start', { hostId: host.hostId, pad: 'x'.repeat(8192) });
        expect(res.status).toBe(413);
    });

    it('署名つきのほかの口（poll・unpair・tunnel）も 413', async () => {
        const big = '{"x":"' + 'x'.repeat(8192) + '"}';
        for (const path of ['/pair/poll', '/pair/unpair', '/pair/tunnel']) {
            const res = await SELF.fetch(`${ORIGIN}${path}`, {
                method: 'POST',
                body: big,
            });
            expect(res.status).toBe(413);
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

describe('接続元のハッシュ（#252）', () => {
    const storedHash = async (host: Host) =>
        (
            await env.DB.prepare('SELECT client_hash FROM pairing_requests WHERE host_id = ?')
                .bind(host.hostId)
                .first<{ client_hash: string }>()
        )?.client_hash;

    it('D1 の鍵での HMAC にする。鍵は初めて要るときに 1 つだけ作る', async () => {
        const ip = '203.0.113.10';
        const a = { ...(await newHost()), ip };
        const b = { ...(await newHost()), ip };
        await startPairing(a);
        await startPairing(b);
        const keys = await env.DB.prepare('SELECT key FROM relay_keys WHERE name = ?')
            .bind(CLIENT_HASH_KEY)
            .all<{ key: string }>();
        expect(keys.results).toHaveLength(1);
        // 同じ接続元は同じハッシュ（回数を数えられる）。鍵での HMAC と一致する
        const hash = await storedHash(a);
        expect(hash).toBe(await storedHash(b));
        expect(hash).toBe(await clientHash(env, ip));
        const b64 = keys.results[0].key.replace(/-/g, '+').replace(/_/g, '/');
        const raw = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
        expect(raw.length).toBe(32);
        const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`client:${ip}`));
        expect(hash).toBe(base64url(mac));
    });

    it('鍵を知らなければ、IP を総当たりしても戻せない', async () => {
        // D1 の中身（client_hash）だけを持っている人が、鍵のない SHA-256 で接続元を探す形
        const ip = '192.0.2.123';
        const host = { ...(await newHost()), ip };
        await startPairing(host);
        const hash = await storedHash(host);
        expect(hash).toBeTruthy();
        const found: string[] = [];
        for (let i = 0; i < 256; i++) {
            const guess = `192.0.2.${i}`;
            for (const text of [`client:${guess}`, guess]) {
                if ((await sha256(text)) === hash) {
                    found.push(guess);
                }
            }
        }
        expect(found).toEqual([]);
    });

    it('鍵の行が壊れていたら、作り直さずに 500 を返す', async () => {
        // 先に鍵を作っておき、壊したあとで元に戻す（ほかのテストに響かせない）
        await startPairing(await newHost());
        const readKey = () =>
            env.DB.prepare('SELECT key FROM relay_keys WHERE name = ?').bind(CLIENT_HASH_KEY).first<{ key: string }>();
        const row = await readKey();
        try {
            for (const broken of ['!!not-base64url!!', 'c2hvcnQ']) {
                await env.DB.prepare('UPDATE relay_keys SET key = ? WHERE name = ?')
                    .bind(broken, CLIENT_HASH_KEY)
                    .run();
                const host = await newHost();
                const res = await hostCall(host, '/pair/start', {
                    hostId: host.hostId,
                    hostName: 'PC',
                    publicKey: host.publicKey,
                });
                expect(res.status).toBe(500);
                expect((await readKey())?.key).toBe(broken);
                // 申請も入れない
                const pending = await env.DB.prepare('SELECT 1 FROM pairing_requests WHERE host_id = ?')
                    .bind(host.hostId)
                    .first();
                expect(pending).toBeNull();
            }
        } finally {
            await env.DB.prepare('UPDATE relay_keys SET key = ? WHERE name = ?').bind(row?.key, CLIENT_HASH_KEY).run();
        }
    });

    it('鍵を入れる前の形の行は数えない（期限で消えるのを待つ）', async () => {
        const ip = '203.0.113.88';
        const now = Date.now();
        const old = await sha256(`client:${ip}`);
        for (let i = 0; i < 5; i++) {
            await env.DB.prepare(
                `INSERT INTO pairing_requests
                    (id, code_hash, host_id, host_name, public_key, client_hash, created_at, expires_at)
                 VALUES (?, ?, ?, 'OLD-PC', 'pk', ?, ?, ?)`,
            )
                .bind(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), old, now - 1000, now + 60_000)
                .run();
        }
        await startPairing({ ...(await newHost()), ip });
    });
});

describe('接続元の国（#251）', () => {
    const seen = async (cookie: string, code: string, from: { ip?: string; country?: string }) => {
        const res = await browser(cookie, `/pair/request?code=${code}`, from);
        expect(res.status).toBe(200);
        return (await res.json()) as Record<string, unknown>;
    };

    it('コードを送りつける手口: ほかの国で申請したコードを開くと知らせる。承認は止めない', async () => {
        // 攻撃する人が自分の PC（US）で申請し、そのコードの URL を被害者（JP）に送る
        const attacker = { ...(await newHost()), ip: '198.51.100.7', country: 'US' };
        const { code } = await startPairing(attacker);
        const victim = await newUser();
        const body = await seen(victim.cookie, code, { ip: '203.0.113.20', country: 'JP' });
        expect(body.countryMismatch).toBe(true);
        // 申請した PC の国は返さない
        expect(Object.values(body)).not.toContain('US');
        expect(Object.keys(body).sort()).toEqual(
            ['answeredByMe', 'code', 'countryMismatch', 'expiresAt', 'hostName', 'status'].sort(),
        );
        // 止めはしない（Tailscale・VPN・モバイル回線で国が変わるため）
        expect((await approve(victim.cookie, code)).status).toBe(200);
    });

    it('コードを盗む手口: 盗んだ人がほかの国から開くと知らせる', async () => {
        const owner = { ...(await newHost()), ip: '203.0.113.30', country: 'JP' };
        const { code } = await startPairing(owner);
        const thief = await newUser();
        expect((await seen(thief.cookie, code, { ip: '198.51.100.30', country: 'T1' })).countryMismatch).toBe(true);
    });

    it('同じ国・同じ接続元なら知らせない', async () => {
        const host = { ...(await newHost()), ip: '203.0.113.40', country: 'JP' };
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        // 同じ国のほかの回線（スマホのモバイル回線など）
        expect((await seen(cookie, code, { ip: '192.0.2.40', country: 'JP' })).countryMismatch).toBe(false);
        // 同じ接続元（client_hash が同じ）なら、国の判定が揺れても知らせない
        expect((await seen(cookie, code, { ip: host.ip, country: 'KR' })).countryMismatch).toBe(false);
    });

    it('client_hash の鍵が壊れていても 500 にせず、国だけで知らせる', async () => {
        const host = { ...(await newHost()), ip: '203.0.113.60', country: 'JP' };
        const { code } = await startPairing(host);
        const { cookie } = await newUser();
        const readKey = () =>
            env.DB.prepare('SELECT key FROM relay_keys WHERE name = ?').bind(CLIENT_HASH_KEY).first<{ key: string }>();
        const row = await readKey();
        try {
            await env.DB.prepare('UPDATE relay_keys SET key = ? WHERE name = ?')
                .bind('!!not-base64url!!', CLIENT_HASH_KEY)
                .run();
            // 同じ接続元でも、ハッシュで比べられないので国だけで判断する
            expect((await seen(cookie, code, { ip: host.ip, country: 'US' })).countryMismatch).toBe(true);
            expect((await seen(cookie, code, { ip: '192.0.2.60', country: 'JP' })).countryMismatch).toBe(false);
            // 鍵は作り直さない
            expect((await readKey())?.key).toBe('!!not-base64url!!');
        } finally {
            await env.DB.prepare('UPDATE relay_keys SET key = ? WHERE name = ?').bind(row?.key, CLIENT_HASH_KEY).run();
        }
    });

    it('どちらかの国がわからない（cf に国がない・XX）ときは比べない', async () => {
        const { cookie } = await newUser();
        const unknownHost = { ...(await newHost()) };
        const a = await startPairing(unknownHost);
        expect((await seen(cookie, a.code, { country: 'JP' })).countryMismatch).toBe(false);
        const xxHost = { ...(await newHost()), country: 'XX' };
        const b = await startPairing(xxHost);
        expect((await seen(cookie, b.code, { country: 'JP' })).countryMismatch).toBe(false);
        const jpHost = { ...(await newHost()), country: 'JP' };
        const c = await startPairing(jpHost);
        expect((await seen(cookie, c.code, {})).countryMismatch).toBe(false);
        expect((await seen(cookie, c.code, { country: 'XX' })).countryMismatch).toBe(false);
    });

    it('D1 には国だけを置く（IP も地域も置かない）', async () => {
        const host = { ...(await newHost()), ip: '198.51.100.99', country: 'DE' };
        await startPairing(host);
        const row = await env.DB.prepare('SELECT * FROM pairing_requests WHERE host_id = ?')
            .bind(host.hostId)
            .first<Record<string, unknown>>();
        expect(row?.client_country).toBe('DE');
        expect(JSON.stringify(row)).not.toContain(host.ip);
        // 形の違う値は置かない
        const odd = { ...(await newHost()), country: 'jp' };
        await startPairing(odd);
        const oddRow = await env.DB.prepare('SELECT client_country FROM pairing_requests WHERE host_id = ?')
            .bind(odd.hostId)
            .first<{ client_country: string | null }>();
        expect(oddRow?.client_country).toBeNull();
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
