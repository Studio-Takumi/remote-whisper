// 初回の同意（#162）。ユーザーとログインセッションは D1 に直接作る
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { TOS_VERSION } from '../src/consent';
import { sha256 } from '../src/http';

const ORIGIN = 'https://rw-dev.example';

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

function send(method: string, path: string, body: unknown, cookie?: string, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) {
        headers.Cookie = cookie;
    }
    if (origin) {
        headers.Origin = origin;
    }
    return SELF.fetch(`${ORIGIN}${path}`, { method, headers, body: JSON.stringify(body) });
}

const consent = (cookie: string | undefined, body: unknown, origin: string | null = ORIGIN) =>
    send('POST', '/me/consent', body, cookie, origin);
const setCollection = (cookie: string | undefined, granted: boolean, origin: string | null = ORIGIN) =>
    send('PUT', '/me/consents/data_collection', { granted }, cookie, origin);

async function getMe(cookie: string) {
    const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as { tosVersion: string | null; tosCurrent: string; dataCollection: boolean };
}

async function history(userId: string, kind: string) {
    const rows = await env.DB.prepare(
        'SELECT granted, version FROM consents WHERE user_id = ? AND kind = ? ORDER BY created_at, rowid',
    )
        .bind(userId, kind)
        .all<{ granted: number; version: string }>();
    return rows.results;
}

describe('初回の同意', () => {
    it('同意する前は tos_version が null で、今の版とデータ収集の状態（オフ）が返る', async () => {
        const { cookie } = await newUser();
        expect(await getMe(cookie)).toMatchObject({ tosVersion: null, tosCurrent: TOS_VERSION, dataCollection: false });
    });

    it('同意すると tos_version が入り、tos とデータ収集が consents に追記される', async () => {
        const { userId, cookie } = await newUser();
        const res = await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: true });
        expect(res.status).toBe(200);
        expect(await getMe(cookie)).toMatchObject({ tosVersion: TOS_VERSION, dataCollection: true });
        expect(await history(userId, 'tos')).toEqual([{ granted: 1, version: TOS_VERSION }]);
        expect(await history(userId, 'data_collection')).toHaveLength(1);
    });

    it('データ収集をオフのまま同意すると、オフが記録される', async () => {
        const { userId, cookie } = await newUser();
        expect((await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false })).status).toBe(200);
        expect((await getMe(cookie)).dataCollection).toBe(false);
        expect((await history(userId, 'data_collection')).map((r) => r.granted)).toEqual([0]);
    });

    it('違う版は 409 で、tos_version は null のまま', async () => {
        const { userId, cookie } = await newUser();
        const res = await consent(cookie, { tosVersion: '1999-01-01', dataCollection: false });
        expect(res.status).toBe(409);
        expect((await getMe(cookie)).tosVersion).toBeNull();
        expect(await history(userId, 'tos')).toEqual([]);
    });

    it('同意済みの再送は 409 で、tos_version も consents も変わらない', async () => {
        const { userId, cookie } = await newUser();
        // 旧い版に同意した人（今の版とは違う）
        await env.DB.prepare('UPDATE users SET tos_version = ? WHERE id = ?').bind('2020-01-01', userId).run();
        const res = await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: true });
        expect(res.status).toBe(409);
        expect((await getMe(cookie)).tosVersion).toBe('2020-01-01');
        expect(await history(userId, 'tos')).toEqual([]);
        expect(await history(userId, 'data_collection')).toEqual([]);

        // 通常の同意のあとの再送も同じ
        const other = await newUser();
        expect((await consent(other.cookie, { tosVersion: TOS_VERSION, dataCollection: false })).status).toBe(200);
        expect((await consent(other.cookie, { tosVersion: TOS_VERSION, dataCollection: true })).status).toBe(409);
        expect(await history(other.userId, 'tos')).toHaveLength(1);
        expect((await history(other.userId, 'data_collection')).map((r) => r.granted)).toEqual([0]);
        expect((await getMe(other.cookie)).dataCollection).toBe(false);
    });

    it('退会すると consents も消える', async () => {
        const { userId, cookie } = await newUser();
        await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: true });
        const res = await SELF.fetch(`${ORIGIN}/me`, { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } });
        expect(res.status).toBe(200);
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM consents WHERE user_id = ?')
            .bind(userId)
            .first<{ n: number }>();
        expect(n?.n).toBe(0);
    });

    it('形が違う本文は 400', async () => {
        const { cookie } = await newUser();
        expect((await consent(cookie, { tosVersion: TOS_VERSION })).status).toBe(400);
        expect((await consent(cookie, { dataCollection: true })).status).toBe(400);
    });

    it('Origin がない・違うときは 403 で、何も変わらない', async () => {
        const { cookie } = await newUser();
        expect((await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false }, null)).status).toBe(403);
        expect(
            (await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false }, 'https://evil.example')).status,
        ).toBe(403);
        expect((await getMe(cookie)).tosVersion).toBeNull();
    });

    it('ログインしていなければ 401', async () => {
        expect((await consent(undefined, { tosVersion: TOS_VERSION, dataCollection: false })).status).toBe(401);
        expect((await setCollection(undefined, true)).status).toBe(401);
    });
});

describe('データ収集の許可の変更', () => {
    it('同意の前は 409', async () => {
        const { userId, cookie } = await newUser();
        expect((await setCollection(cookie, true)).status).toBe(409);
        expect(await history(userId, 'data_collection')).toEqual([]);
    });

    it('オン・オフの履歴が順に残り、今の状態は最後の行', async () => {
        const { userId, cookie } = await newUser();
        await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false });
        for (const granted of [true, false, false, true]) {
            const res = await setCollection(cookie, granted);
            expect(res.status).toBe(200);
            expect((await getMe(cookie)).dataCollection).toBe(granted);
        }
        // 同意のときの 1 行 + 変更 4 回（同じ値の追記も残る）
        expect((await history(userId, 'data_collection')).map((r) => r.granted)).toEqual([0, 1, 0, 0, 1]);
    });

    it('Origin がない・違うときは 403', async () => {
        const { userId, cookie } = await newUser();
        await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false });
        expect((await setCollection(cookie, true, null)).status).toBe(403);
        expect((await setCollection(cookie, true, 'https://evil.example')).status).toBe(403);
        expect(await history(userId, 'data_collection')).toHaveLength(1);
    });

    it('granted が真偽値でなければ 400', async () => {
        const { cookie } = await newUser();
        await consent(cookie, { tosVersion: TOS_VERSION, dataCollection: false });
        expect((await send('PUT', '/me/consents/data_collection', { granted: 'yes' }, cookie)).status).toBe(400);
    });
});
