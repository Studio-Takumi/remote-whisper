// セキュリティのヘッダー（#166）。Worker が答える返事と、中継した返事
import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/http';
import { withSecurityHeaders } from '../src/index';
import { attachmentDisposition, safeResponseHeaders } from '../src/relay';

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
        // パス → [型, 本文, ホストが付けた Content-Disposition, 期待する Content-Disposition]
        const bodies: Record<string, [string | null, string, string | null, string | null]> = {
            '/api/evil.html': ['text/html; charset=utf-8', '<script>alert(1)</script>', null, 'attachment'],
            '/api/evil.svg': ['image/svg+xml', '<svg onload="alert(1)"/>', null, 'attachment'],
            '/api/ok.json': ['application/json', '{}', null, null],
            // 型がないものは、中身から HTML と推測されることがあるのでダウンロード
            '/api/untyped': [null, '<script>alert(1)</script>', null, 'attachment'],
            // 書き出し: inline を attachment に替え、ファイル名は残す
            '/api/export.html': [
                'text/html',
                '<h1>x</h1>',
                `inline; filename="meeting.html"; filename*=UTF-8''%E4%BC%9A%E8%AD%B0.html`,
                `attachment; filename="meeting.html"; filename*=UTF-8''%E4%BC%9A%E8%AD%B0.html`,
            ],
            // 描かせないものは、ホストの値をそのまま通す
            '/api/export.md': ['text/markdown', '# x', 'attachment; filename="a.md"', 'attachment; filename="a.md"'],
        };
        spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const path = new URL(new Request(input as RequestInfo).url).pathname;
            const [type, body, disposition] = bodies[path];
            const res = new Response(body, { headers: { 'Content-Security-Policy': "script-src 'unsafe-inline'" } });
            // 本文が文字列だと text/plain が付くので、付け直すか消す
            res.headers.delete('Content-Type');
            if (type) {
                res.headers.set('Content-Type', type);
            }
            if (disposition) {
                res.headers.set('Content-Disposition', disposition);
            }
            return res;
        });
        for (const [path, [, , , expected]] of Object.entries(bodies)) {
            const res = await SELF.fetch(`${ORIGIN}/h/${hostId}${path}`, {
                headers: { Cookie: `__Host-rw_session=${token}` },
            });
            expect(res.status, path).toBe(200);
            // ホストの CSP は使わず、こちらの sandbox にする
            expect(res.headers.get('Content-Security-Policy'), path).toContain('sandbox');
            expect(res.headers.get('X-Frame-Options'), path).toBe('DENY');
            expect(res.headers.get('Content-Disposition'), path).toBe(expected);
        }
    });
});

describe('ダウンロードにするときの Content-Disposition（#253）', () => {
    it('ホストの値がなければ attachment だけ', () => {
        expect(attachmentDisposition(null)).toBe('attachment');
        expect(attachmentDisposition('inline')).toBe('attachment');
    });

    it('種類は attachment に替え、filename と filename* を残す', () => {
        expect(attachmentDisposition('inline; filename=report.html')).toBe('attachment; filename="report.html"');
        expect(attachmentDisposition(`attachment; filename*=utf-8''r%C3%A9sum%C3%A9.svg`)).toBe(
            `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.svg`,
        );
        // 大文字の名前、; を含む引用符の中、同じ名前が 2 つあれば最初のもの
        expect(attachmentDisposition('INLINE; FILENAME="a;b.html"; filename="c.html"')).toBe(
            'attachment; filename="a;b.html"',
        );
    });

    it('引用符と \\ は逃がし直す（ヘッダーの中で値を閉じさせない）', () => {
        const out = attachmentDisposition('inline; filename="a\\"; x=\\"y.html"');
        expect(out).toBe('attachment; filename="a\\"; x=\\"y.html"');
        expect(attachmentDisposition('inline; filename="back\\\\slash.html"')).toBe(
            'attachment; filename="back\\\\slash.html"',
        );
        // 引用符で囲まれていない " は、そのまま値の一部として逃がす
        expect(attachmentDisposition('inline; filename=a"b.html')).toBe('attachment; filename="a\\"b.html"');
    });

    it('CR・LF などの制御文字と ASCII 以外は _ にする。filename* はデコードして制御文字が出たら落とす', () => {
        expect(attachmentDisposition('inline; filename="a\r\nSet-Cookie: x=1.html"')).toBe(
            'attachment; filename="a__Set-Cookie: x=1.html"',
        );
        expect(attachmentDisposition('inline; filename="議事録.html"')).toBe('attachment; filename="___.html"');
        expect(attachmentDisposition(`inline; filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x.html`)).toBe('attachment');
        expect(attachmentDisposition(`inline; filename*=UTF-8''a%00.html`)).toBe('attachment');
    });

    it('形の合わない filename* は落とす（UTF-8 以外・生の空白や引用符・壊れた %XX・UTF-8 として読めない）', () => {
        for (const bad of [
            `iso-8859-1''a.html`,
            `UTF-8''a b.html`,
            `UTF-8''a".html`,
            `UTF-8''a%zz.html`,
            `UTF-8''%FF.html`,
            `UTF-8''`,
            `UTF-8'en'a.html`,
        ]) {
            expect(attachmentDisposition(`inline; filename*=${bad}`), bad).toBe('attachment');
        }
    });

    it('空の名前・長すぎる名前', () => {
        expect(attachmentDisposition('inline; filename=""')).toBe('attachment');
        expect(attachmentDisposition('inline; filename="   "')).toBe('attachment');
        const long = attachmentDisposition(`inline; filename="${'a'.repeat(1000)}.html"`);
        expect(long).toBe(`attachment; filename="${'a'.repeat(255)}"`);
    });

    it('中継の返事の組み立て: ホストの CSP・Set-Cookie を落とし、ファイル名つきの attachment にする', () => {
        const res = new Response('x', {
            headers: {
                'Content-Type': 'image/svg+xml',
                'Content-Disposition': 'inline; filename="chart.svg"',
                'Set-Cookie': 'a=1',
                'Content-Security-Policy-Report-Only': 'default-src *',
            },
        });
        const out = safeResponseHeaders(res);
        expect(out.get('Content-Disposition')).toBe('attachment; filename="chart.svg"');
        expect(out.get('Set-Cookie')).toBeNull();
        expect(out.get('Content-Security-Policy-Report-Only')).toBeNull();
        expect(out.get('Content-Security-Policy')).toContain('sandbox');
    });
});
