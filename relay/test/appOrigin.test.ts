// アプリに同梱した画面のオリジン（#440）。CORS は資格情報なしで、Cookie のログインは使わせない
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { appOrigins, isAppOrigin } from '../src/appOrigin';
import { sha256 } from '../src/http';

const ORIGIN = 'https://rw-dev.example';
const APP = 'capacitor://localhost';
const HOST_ID = '11111111-2222-4333-8444-555555555555';

async function newCookie() {
    const userId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, 'たろう', now),
        env.DB.prepare(
            'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + 3_600_000, now),
    ]);
    return `__Host-rw_session=${token}`;
}

function preflight(path: string, origin: string) {
    return SELF.fetch(`${ORIGIN}${path}`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
}

describe('設定', () => {
    it('カンマ区切りで、空なら許さない', () => {
        expect(appOrigins({ APP_ORIGINS: ' capacitor://localhost , ' })).toEqual([APP]);
        expect(appOrigins({ APP_ORIGINS: '' })).toEqual([]);
        expect(appOrigins({})).toEqual([]);
        const req = new Request(`${ORIGIN}/me`, { headers: { Origin: APP } });
        expect(isAppOrigin(req, { APP_ORIGINS: APP })).toBe(true);
        expect(isAppOrigin(req, { APP_ORIGINS: '' })).toBe(false);
        expect(isAppOrigin(new Request(`${ORIGIN}/me`, { headers: { Origin: 'capacitor://evil' } }), env)).toBe(false);
    });
    it('wrangler.jsonc で capacitor://localhost を許している', () => {
        expect(appOrigins(env)).toEqual([APP]);
    });
});

describe('CORS', () => {
    it('/h/ と /me の preflight に、資格情報なしで答える', async () => {
        for (const path of [`/h/${HOST_ID}/api/projects`, `/h/${HOST_ID}/ws`, '/me', '/me/hosts']) {
            const res = await preflight(path, APP);
            expect(res.status, path).toBe(204);
            expect(res.headers.get('Access-Control-Allow-Origin'), path).toBe(APP);
            expect(res.headers.get('Access-Control-Allow-Methods'), path).toContain('POST');
            expect(res.headers.get('Access-Control-Allow-Credentials'), path).toBeNull();
            expect(res.headers.get('Vary'), path).toContain('Origin');
        }
    });

    it('ほかのオリジン・ほかのパスの preflight には CORS を付けない', async () => {
        for (const [path, origin] of [
            ['/me', 'https://evil.example'],
            ['/me', 'capacitor://evil'],
            ['/me', 'ionic://localhost'],
            ['/auth/logout', APP],
            ['/pair/start', APP],
        ]) {
            const res = await preflight(path, origin);
            expect(res.headers.get('Access-Control-Allow-Origin'), `${origin} ${path}`).toBeNull();
        }
    });

    it('返事にも付ける。Cookie があってもログインしていない扱い（401）', async () => {
        const cookie = await newCookie();
        const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Origin: APP, Cookie: cookie } });
        expect(res.status).toBe(401);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
        const relayed = await SELF.fetch(`${ORIGIN}/h/${HOST_ID}/api/projects`, {
            headers: { Origin: APP, Cookie: cookie },
        });
        expect(relayed.status).toBe(401);
        expect(relayed.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    });

    it('状態を変えるものも Cookie では通らない（CSRF の確かめ方は変えない）', async () => {
        const cookie = await newCookie();
        const res = await SELF.fetch(`${ORIGIN}/me`, { method: 'DELETE', headers: { Origin: APP, Cookie: cookie } });
        expect(res.status).toBe(401);
        const logout = await SELF.fetch(`${ORIGIN}/auth/logout`, {
            method: 'POST',
            headers: { Origin: APP, Cookie: cookie },
        });
        expect(logout.status).toBe(403);
        // 自分のオリジンの画面からは、前と同じく使える（消えていない）
        const me = await SELF.fetch(`${ORIGIN}/me`, { headers: { Origin: ORIGIN, Cookie: cookie } });
        expect(me.status).toBe(200);
        expect(me.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('/h/ と /me には、どのオリジンでも Vary: Origin を付ける（重ねない）。ほかのパスには付けない', async () => {
        for (const origin of [APP, ORIGIN, null]) {
            for (const path of ['/me', `/h/${HOST_ID}/api/projects`]) {
                const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: origin ? { Origin: origin } : {} });
                const vary = (res.headers.get('Vary') ?? '').split(',').map((v) => v.trim());
                expect(
                    vary.filter((v) => v.toLowerCase() === 'origin'),
                    `${origin} ${path}`,
                ).toEqual(['Origin']);
            }
        }
        const other = await SELF.fetch(`${ORIGIN}/pair/request?code=ABCD-EFGH`, { headers: { Origin: APP } });
        expect(other.headers.get('Vary') ?? '').not.toContain('Origin');
    });
});
