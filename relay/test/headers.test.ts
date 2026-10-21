// セキュリティのヘッダー（#166）。Worker が答える返事と、中継した返事
import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/http';
import { withSecurityHeaders } from '../src/index';

const ORIGIN = 'https://rw-dev.example';

describe('Worker が答える返事', () => {
    it('/healthz にも付ける', async () => {
        const res = await SELF.fetch(`${ORIGIN}/healthz`);
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('iframe に入れさせず、型を推測させず、アカウント・登録・ログインはキャッシュさせない', async () => {
        for (const path of ['/me', '/pair/request?code=ABCD-EFGH', '/auth/login/nope']) {
            const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
            expect(res.headers.get('X-Frame-Options'), path).toBe('DENY');
            expect(res.headers.get('X-Content-Type-Options'), path).toBe('nosniff');
            expect(res.headers.get('Content-Security-Policy'), path).toContain("frame-ancestors 'none'");
            expect(res.headers.get('Cache-Control'), path).toBe('no-store');
        }
    });

    it('ヘッダーを変えられない返事も作り直して付ける（Set-Cookie は残す）。WebSocket（101）はそのまま', async () => {
        // Response.redirect のヘッダーは変えられない
        const frozen = Response.redirect(`${ORIGIN}/`, 302);
        expect(() => frozen.headers.set('X', '1')).toThrow();
        const res = withSecurityHeaders(frozen, '/auth/callback/github');
        expect(res).not.toBe(frozen);
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${ORIGIN}/`);
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
        // 変えられる返事は、そのまま付ける（Set-Cookie が 2 つあっても残る）
        const twoCookies = new Response(null, { status: 302, headers: { Location: '/' } });
        twoCookies.headers.append('Set-Cookie', 'a=1; Path=/');
        twoCookies.headers.append('Set-Cookie', 'b=2; Path=/');
        const kept = withSecurityHeaders(twoCookies, '/auth/callback/github');
        expect(kept.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
        expect(kept.headers.get('Cache-Control')).toBe('no-store');
        const pair = new WebSocketPair();
        const ws = new Response(null, { status: 101, webSocket: pair[0] });
        expect(withSecurityHeaders(ws, '/h/x/ws')).toBe(ws);
    });
});

describe('中継した返事', () => {
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    afterEach(() => spy?.mockRestore());

    it('このオリジンの文書として描かせない（sandbox、HTML・SVG はダウンロード）', async () => {
        const userId = crypto.randomUUID();
        const token = crypto.randomUUID();
        const hostId = crypto.randomUUID();
        const now = Date.now();
        await env.DB.batch([
            env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, 'x', now),
            env.DB.prepare(
                'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
            ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + 3_600_000, now),
            env.DB.prepare(
                'INSERT INTO hosts (id, user_id, name, public_key, relay_key, tunnel_hostname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).bind(
                hostId,
                userId,
                'PC',
                'pk',
                'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
                `rwt-${hostId.replace(/-/g, '').slice(0, 12)}.example.dev`,
                now,
            ),
        ]);
        const bodies: Record<string, [string, string]> = {
            '/api/evil.html': ['text/html; charset=utf-8', '<script>alert(1)</script>'],
            '/api/evil.svg': ['image/svg+xml', '<svg onload="alert(1)"/>'],
            '/api/ok.json': ['application/json', '{}'],
        };
        spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const path = new URL(new Request(input as RequestInfo).url).pathname;
            const [type, body] = bodies[path];
            return new Response(body, {
                headers: { 'Content-Type': type, 'Content-Security-Policy': "script-src 'unsafe-inline'" },
            });
        });
        for (const [path] of Object.entries(bodies)) {
            const res = await SELF.fetch(`${ORIGIN}/h/${hostId}${path}`, {
                headers: { Cookie: `__Host-rw_session=${token}` },
            });
            expect(res.status, path).toBe(200);
            // ホストの CSP は使わず、こちらの sandbox にする
            expect(res.headers.get('Content-Security-Policy'), path).toContain('sandbox');
            expect(res.headers.get('X-Frame-Options'), path).toBe('DENY');
            const attachment = res.headers.get('Content-Disposition');
            expect(attachment, path).toBe(path.endsWith('.json') ? null : 'attachment');
        }
    });
});
