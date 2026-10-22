// トンネルの作成・削除（#159）。Cloudflare の API は偽物に差し替える
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base64url, sha256 } from '../src/http';

const ORIGIN = 'https://rw-dev.example';
const API = 'https://api.cloudflare.com/client/v4';

// --- 偽の Cloudflare ---

type Fake = {
    tunnels: Map<string, { name: string; config?: unknown; connections: boolean }>;
    dns: Map<string, { name: string; content: string }>;
    calls: string[];
    fail: string | null;
};
let cf: Fake;
let spy: ReturnType<typeof vi.spyOn>;

const ok = (result: unknown) => Response.json({ success: true, result });
const ng = (status = 400) =>
    Response.json({ success: false, result: null, errors: [{ code: 1000, message: 'nope' }] }, { status });

function fakeCloudflare(input: RequestInfo | URL, init?: RequestInit) {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const path = url.pathname.replace('/client/v4', '');
    cf.calls.push(`${req.method} ${path}`);
    if (req.headers.get('Authorization') !== 'Bearer cf-token') {
        return Promise.resolve(ng(403));
    }
    if (cf.fail && `${req.method} ${path}`.includes(cf.fail)) {
        return Promise.resolve(ng(500));
    }
    return (async () => {
        const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json<Record<string, unknown>>();
        let m: RegExpExecArray | null;
        if (req.method === 'GET' && path === '/accounts/acct/cfd_tunnel') {
            const name = url.searchParams.get('name');
            return ok([...cf.tunnels].filter(([, t]) => t.name === name).map(([id]) => ({ id })));
        }
        if (req.method === 'POST' && path === '/accounts/acct/cfd_tunnel') {
            // 同じ名前の生きているトンネルは作れない
            if ([...cf.tunnels.values()].some((t) => t.name === String(body?.name))) {
                return ng(409);
            }
            const id = crypto.randomUUID();
            cf.tunnels.set(id, { name: String(body?.name), connections: true });
            return ok({ id });
        }
        if ((m = /^\/accounts\/acct\/cfd_tunnel\/([^/]+)(\/.*)?$/.exec(path))) {
            const t = cf.tunnels.get(m[1]);
            if (!t) {
                return ng(404);
            }
            if (m[2] === '/configurations' && req.method === 'PUT') {
                t.config = body?.config;
                return ok({});
            }
            if (m[2] === '/token' && req.method === 'GET') {
                return ok(`token-${m[1]}`);
            }
            if (m[2] === '/connections' && req.method === 'DELETE') {
                t.connections = false;
                return ok({});
            }
            if (!m[2] && req.method === 'GET') {
                return ok({ id: m[1], status: t.connections ? 'healthy' : 'down' });
            }
            if (!m[2] && req.method === 'DELETE') {
                if (t.connections) {
                    return ng(400);
                }
                cf.tunnels.delete(m[1]);
                return ok({});
            }
        }
        if (path === '/zones/zone/dns_records' && req.method === 'GET') {
            const name = url.searchParams.get('name');
            return ok([...cf.dns].filter(([, r]) => r.name === name).map(([id, r]) => ({ id, content: r.content })));
        }
        if (path === '/zones/zone/dns_records' && req.method === 'POST') {
            const id = crypto.randomUUID();
            cf.dns.set(id, { name: String(body?.name), content: String(body?.content) });
            return ok({ id });
        }
        if ((m = /^\/zones\/zone\/dns_records\/([^/]+)$/.exec(path))) {
            if (req.method === 'DELETE') {
                cf.dns.delete(m[1]);
                return ok({});
            }
            cf.dns.set(m[1], { name: String(body?.name), content: String(body?.content) });
            return ok({ id: m[1] });
        }
        return ng(404);
    })();
}

beforeEach(() => {
    cf = { tunnels: new Map(), dns: new Map(), calls: [], fail: null };
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith(API)) {
            return fakeCloudflare(input, init);
        }
        throw new Error(`unexpected fetch ${url}`);
    });
});
afterEach(() => {
    spy.mockRestore();
});

// --- ホストとユーザー ---

type Host = { hostId: string; keys: CryptoKeyPair; publicKey: string };

async function hex(body: string) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hostCall(host: Host, path: string, payload: object, key?: CryptoKey) {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const message = ['v1', host.hostId, String(ts), 'POST', path, await hex(body)].join('\n');
    const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        key ?? host.keys.privateKey,
        new TextEncoder().encode(message),
    );
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 250)}`,
            'X-RW-Host': `v1;host=${host.hostId};ts=${ts};sig=${base64url(sig)}`,
        },
        body,
    });
}

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

// 登録まで済んだホスト
async function registeredHost(cookie: string, hostId: string = crypto.randomUUID()): Promise<Host> {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer;
    const host = { hostId, keys, publicKey: base64url(raw) };
    const start = await hostCall(host, '/pair/start', {
        hostId: host.hostId,
        hostName: 'PC',
        publicKey: host.publicKey,
    });
    const { code } = (await start.json()) as { code: string };
    const res = await SELF.fetch(`${ORIGIN}/pair/approve`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    return host;
}

const row = (hostId: string) =>
    env.DB.prepare('SELECT tunnel_id, tunnel_hostname, app_version, last_seen_at FROM hosts WHERE id = ?')
        .bind(hostId)
        .first<{
            tunnel_id: string | null;
            tunnel_hostname: string | null;
            app_version: string | null;
            last_seen_at: number | null;
        }>();

// /pair/tunnel は 1 台あたり 5 秒に 1 回まで（#166）。続けて呼ぶテストでは、前の呼び出しを昔のことにする
const later = (hostId: string) => env.DB.prepare('UPDATE hosts SET last_seen_at = 0 WHERE id = ?').bind(hostId).run();

describe('トンネルを用意する（POST /pair/tunnel）', () => {
    it('初めてならトンネル・設定・DNS を作り、トークンと公開ホスト名を返す。2 回目は作らない', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        const res = await hostCall(host, '/pair/tunnel', { appVersion: '1.2.3' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { token: string; hostname: string };
        const expected = `rwt-local-${host.hostId.replace(/-/g, '').slice(0, 12)}.studio-takumi.dev`;
        expect(body.hostname).toBe(expected);
        const saved = await row(host.hostId);
        expect(saved?.tunnel_hostname).toBe(expected);
        expect(saved?.app_version).toBe('1.2.3');
        expect(saved?.last_seen_at).toBeTypeOf('number');
        expect(body.token).toBe(`token-${saved?.tunnel_id}`);
        const tunnel = cf.tunnels.get(saved?.tunnel_id ?? '');
        expect(tunnel?.config).toEqual({
            ingress: [{ hostname: expected, service: 'http://127.0.0.1:8001' }, { service: 'http_status:404' }],
        });
        expect([...cf.dns.values()]).toEqual([{ name: expected, content: `${saved?.tunnel_id}.cfargotunnel.com` }]);

        // 5 秒以内にもう一度呼ぶと断る（Cloudflare の API を呼ばない）
        cf.calls = [];
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(429);
        expect(cf.calls).toEqual([]);
        await later(host.hostId);
        const again = await hostCall(host, '/pair/tunnel', {});
        expect(again.status).toBe(200);
        // 2 回目はトンネルを作らない（設定と DNS を確かめ直して、トークンをもらう。DNS は同じ向き先なので書かない）
        expect(cf.calls).toEqual([
            `PUT /accounts/acct/cfd_tunnel/${saved?.tunnel_id}/configurations`,
            'GET /zones/zone/dns_records',
            `GET /accounts/acct/cfd_tunnel/${saved?.tunnel_id}/token`,
        ]);
        expect(cf.tunnels.size).toBe(1);
    });

    it('頭 12 桁が他人のホストと同じでも、その人の DNS を書き換えない（長い名前を使う）', async () => {
        const alice = await newUser();
        const victim = await registeredHost(alice.cookie);
        await hostCall(victim, '/pair/tunnel', {});
        const victimRow = await row(victim.hostId);
        const victimDns = [...cf.dns.values()];
        // 攻撃者は、頭 12 桁を合わせたホスト ID で登録する
        const bob = await newUser();
        const forgedId = `${victim.hostId.slice(0, 13)}-4aaa-8aaa-aaaaaaaaaaaa`;
        const attacker = await registeredHost(bob.cookie, forgedId);
        const res = await hostCall(attacker, '/pair/tunnel', {});
        expect(res.status).toBe(200);
        const body = (await res.json()) as { hostname: string };
        expect(body.hostname).toBe(`rwt-local-${forgedId.replace(/-/g, '')}.studio-takumi.dev`);
        expect(body.hostname).not.toBe(victimRow?.tunnel_hostname);
        // 被害者の DNS はそのまま、攻撃者には別のレコード
        expect([...cf.dns.values()].filter((r) => r.name === victimRow?.tunnel_hostname)).toEqual(victimDns);
        expect(cf.dns.size).toBe(2);
    });

    it('消し損ねた古い DNS のレコードは、名前を押さえたホストのトンネルに向け直す', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        const name = `rwt-local-${host.hostId.replace(/-/g, '').slice(0, 12)}.studio-takumi.dev`;
        cf.dns.set('stale', { name, content: 'old-tunnel.cfargotunnel.com' });
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(200);
        const tunnelId = (await row(host.hostId))?.tunnel_id;
        expect(cf.dns.get('stale')?.content).toBe(`${tunnelId}.cfargotunnel.com`);
        expect(cf.dns.size).toBe(1);
    });

    it('途中で失敗しても、次は続きから作る（トンネルを作り直さない）', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        cf.fail = 'dns_records';
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(502);
        const half = await row(host.hostId);
        expect(half?.tunnel_id).toBeTruthy();
        // 名前は押さえてある（DNS はまだ）
        expect(half?.tunnel_hostname).toBeTruthy();
        expect(cf.dns.size).toBe(0);
        cf.fail = null;
        await later(host.hostId);
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(200);
        expect(cf.tunnels.size).toBe(1);
        expect(cf.dns.size).toBe(1);
    });

    it('登録していない・署名がほかの鍵のホストには作らない', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
        expect((await hostCall(host, '/pair/tunnel', {}, other.privateKey)).status).toBe(401);
        const stranger = { ...host, hostId: crypto.randomUUID() };
        expect((await hostCall(stranger, '/pair/tunnel', {})).status).toBe(404);
        expect(cf.calls).toEqual([]);
    });

    it('作ったあと DB に残す前に落ちていても、同じ名前のトンネルを使い直す（作り直そうとして詰まらない）', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        // 前の回に作られたまま、DB には残っていないトンネル
        const orphan = crypto.randomUUID();
        cf.tunnels.set(orphan, { name: `rw-dev-${host.hostId}`, connections: false });
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(200);
        expect((await row(host.hostId))?.tunnel_id).toBe(orphan);
        expect(cf.tunnels.size).toBe(1);
    });

    it('同時に 2 回呼ばれても、トンネルは 1 つだけ残る', async () => {
        const { cookie } = await newUser();
        const host = await registeredHost(cookie);
        const [a, b] = await Promise.all([hostCall(host, '/pair/tunnel', {}), hostCall(host, '/pair/tunnel', {})]);
        // 片方は 429（間隔の制限）か 502（名前の重複）になってもよいが、残るトンネルは 1 つで、DB と一致する
        expect([a.status, b.status]).toContain(200);
        expect(cf.tunnels.size).toBe(1);
        expect(cf.tunnels.has((await row(host.hostId))?.tunnel_id ?? '')).toBe(true);
        await later(host.hostId);
        expect((await hostCall(host, '/pair/tunnel', {})).status).toBe(200);
    });
});

describe('ホストの一覧と管理（#161）', () => {
    const list = async (cookie: string) =>
        (await (await SELF.fetch(`${ORIGIN}/me/hosts`, { headers: { Cookie: cookie } })).json()) as {
            hosts: { id: string; name: string; online: boolean | null; appVersion: string | null }[];
        };

    it('オンラインかどうかはトンネルの状態から出す。トンネルがまだないものは null', async () => {
        const { cookie } = await newUser();
        const a = await registeredHost(cookie);
        const b = await registeredHost(cookie);
        await hostCall(a, '/pair/tunnel', { appVersion: '0.9.0' });
        await hostCall(b, '/pair/tunnel', {});
        const c = await registeredHost(cookie);
        // b の cloudflared は切れた
        const bTunnel = (await row(b.hostId))?.tunnel_id ?? '';
        const t = cf.tunnels.get(bTunnel);
        if (t) {
            t.connections = false;
        }
        const { hosts } = await list(cookie);
        expect(hosts.map((h) => [h.id, h.online])).toEqual([
            [a.hostId, true],
            [b.hostId, false],
            [c.hostId, null],
        ]);
        expect(hosts[0].appVersion).toBe('0.9.0');
        // しばらくは覚えておいた状態を返し、Cloudflare の API を呼ばない（#166。一覧の連打で API を使い切らせない）
        cf.calls = [];
        cf.fail = 'GET /accounts';
        expect((await list(cookie)).hosts.map((h) => h.online)).toEqual([true, false, null]);
        expect(cf.calls).toEqual([]);
    });

    it('Cloudflare の API が使えなければ null（一覧は出す）', async () => {
        const { cookie } = await newUser();
        const a = await registeredHost(cookie);
        await hostCall(a, '/pair/tunnel', {});
        cf.fail = 'GET /accounts';
        expect((await list(cookie)).hosts.map((h) => h.online)).toEqual([null]);
    });

    it('ホストは 1 人 5 台まで', async () => {
        const { cookie } = await newUser();
        for (let i = 0; i < 5; i++) {
            await registeredHost(cookie);
        }
        const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
        const raw = (await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer;
        const sixth = { hostId: crypto.randomUUID(), keys, publicKey: base64url(raw) };
        const start = await hostCall(sixth, '/pair/start', {
            hostId: sixth.hostId,
            hostName: 'PC',
            publicKey: sixth.publicKey,
        });
        const { code } = (await start.json()) as { code: string };
        const res = await SELF.fetch(`${ORIGIN}/pair/approve`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        expect(res.status).toBe(409);
        expect((await list(cookie)).hosts).toHaveLength(5);
    });

    it('名前を変えられる（自分のホストだけ・書式の文字は除く・長さの制限）', async () => {
        const alice = await newUser();
        const bob = await newUser();
        const host = await registeredHost(alice.cookie);
        const rename = (cookie: string, name: unknown, origin: string | null = ORIGIN) =>
            SELF.fetch(`${ORIGIN}/me/hosts/${host.hostId}`, {
                method: 'PATCH',
                headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
                body: JSON.stringify({ name }),
            });
        expect((await rename(alice.cookie, ' 書斎の‮PC ')).status).toBe(200);
        expect((await list(alice.cookie)).hosts[0].name).toBe('書斎のPC');
        expect((await rename(bob.cookie, 'x')).status).toBe(404);
        expect((await rename(alice.cookie, 'x', 'https://evil.example')).status).toBe(403);
        expect((await rename(alice.cookie, '')).status).toBe(400);
        expect((await rename(alice.cookie, 'x'.repeat(65))).status).toBe(400);
        expect((await rename(alice.cookie, 3)).status).toBe(400);
    });
});

describe('トンネルを消す', () => {
    async function withTunnel() {
        const user = await newUser();
        const host = await registeredHost(user.cookie);
        await hostCall(host, '/pair/tunnel', {});
        expect(cf.tunnels.size).toBe(1);
        return { ...user, host };
    }

    it('ホストの「クラウド版から外す」（/pair/unpair）。DNS → 接続 → トンネルの順に消す', async () => {
        const { host } = await withTunnel();
        const tunnelId = (await row(host.hostId))?.tunnel_id;
        cf.calls = [];
        expect((await hostCall(host, '/pair/unpair', {})).status).toBe(200);
        expect(cf.tunnels.size).toBe(0);
        expect(cf.dns.size).toBe(0);
        expect(await row(host.hostId)).toBeNull();
        expect(cf.calls.filter((c) => c.startsWith('DELETE')).map((c) => c.replace(/[0-9a-f-]{36}/g, 'ID'))).toEqual([
            'DELETE /zones/zone/dns_records/ID',
            'DELETE /accounts/acct/cfd_tunnel/ID/connections',
            'DELETE /accounts/acct/cfd_tunnel/ID',
        ]);
        expect(tunnelId).toBeTruthy();
    });

    it('他人のホストは画面から外せない', async () => {
        const { host } = await withTunnel();
        const bob = await newUser();
        const res = await SELF.fetch(`${ORIGIN}/me/hosts/${host.hostId}`, {
            method: 'DELETE',
            headers: { Cookie: bob.cookie, Origin: ORIGIN },
        });
        expect(res.status).toBe(404);
        expect(cf.tunnels.size).toBe(1);
    });

    it('画面から外す（DELETE /me/hosts/:id）', async () => {
        const { host, cookie } = await withTunnel();
        const res = await SELF.fetch(`${ORIGIN}/me/hosts/${host.hostId}`, {
            method: 'DELETE',
            headers: { Cookie: cookie, Origin: ORIGIN },
        });
        expect(res.status).toBe(200);
        expect(cf.tunnels.size).toBe(0);
        expect(cf.dns.size).toBe(0);
    });

    it('退会（DELETE /me）', async () => {
        const { cookie } = await withTunnel();
        const res = await SELF.fetch(`${ORIGIN}/me`, { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } });
        expect(res.status).toBe(200);
        expect(cf.tunnels.size).toBe(0);
        expect(cf.dns.size).toBe(0);
    });

    it('Cloudflare で消せなくても、DB の行は消す', async () => {
        const { host } = await withTunnel();
        cf.fail = 'DELETE';
        expect((await hostCall(host, '/pair/unpair', {})).status).toBe(200);
        expect(await row(host.hostId)).toBeNull();
    });
});
