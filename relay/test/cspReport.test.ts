// CSP の違反の報告（#253）。ログインなしで受け、決まった項目だけを書く。クエリ・ID・抜粋・ほかのオリジンの報告は書かない
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
    MAX_BODY_BYTES,
    MAX_POINTS,
    blockedOf,
    cspDataPoints,
    handleCspReport,
    parseViolation,
    screenPath,
} from '../src/cspReport';
import type { Env } from '../src/index';
import worker from '../src/index';

const ORIGIN = 'https://rw-dev.example';
const SAFARI_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SESSION = '0c6f1d1e-2b9a-4c3e-9d6f-4b8a1e2f3c4d';
const HOST = '11111111-1111-4111-8111-111111111111';

// report-uri の形（application/csp-report）
function legacy(extra: Record<string, unknown> = {}) {
    return {
        'csp-report': {
            'document-uri': `${ORIGIN}/s/${SESSION}?token=SECRET-QUERY#frag`,
            referrer: `${ORIGIN}/?secret=1`,
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'original-policy': "default-src 'self'; script-src 'self'",
            disposition: 'enforce',
            'blocked-uri': 'inline',
            'status-code': 200,
            'script-sample': 'alert("SECRET-SAMPLE")',
            'source-file': `${ORIGIN}/assets/index-abc.js`,
            'line-number': 12,
            ...extra,
        },
    };
}

// Reporting API の形（application/reports+json）
function modern(body: Record<string, unknown> = {}) {
    return {
        type: 'csp-violation',
        age: 10,
        url: `${ORIGIN}/settings/whisper?x=SECRET-QUERY`,
        user_agent: SAFARI_IOS,
        body: {
            documentURL: `${ORIGIN}/settings/whisper?x=SECRET-QUERY`,
            effectiveDirective: 'connect-src',
            blockedURL: `wss://rw-dev.example/h/${HOST}/ws?token=SECRET-QUERY`,
            disposition: 'report',
            originalPolicy: "connect-src 'self'",
            sample: 'SECRET-SAMPLE',
            statusCode: 200,
            ...body,
        },
    };
}

function fakeEnv(limiter?: (key: string) => boolean | Promise<boolean>) {
    const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
    const keys: string[] = [];
    const metrics = { writeDataPoint: (p: (typeof points)[number]) => points.push(p) };
    const limit = limiter && {
        limit: async ({ key }: { key: string }) => {
            keys.push(key);
            return { success: await limiter(key) };
        },
    };
    return {
        points,
        keys,
        env: { ...env, METRICS: metrics, CSP_REPORT_LIMITER: limit } as unknown as Env,
    };
}

function post(body: string, headers: Record<string, string> = {}) {
    return new Request(`${ORIGIN}/csp-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report', 'User-Agent': SAFARI_IOS, ...headers },
        body,
    });
}

describe('報告を読む', () => {
    it('report-uri の形: ディレクティブ・強制か・画面のパス（ID は伏せる）・種類だけ', () => {
        expect(parseViolation(legacy(), ORIGIN)).toEqual({
            directive: 'script-src-elem',
            disposition: 'enforce',
            page: '/s/:id',
            blocked: 'inline',
        });
    });

    it('Reporting API の形: 同じオリジンの URL は self とパスにし、クエリは捨てる', () => {
        expect(parseViolation(modern(), ORIGIN)).toEqual({
            directive: 'connect-src',
            disposition: 'report',
            page: '/settings/:v',
            // 同じホストの wss: は self:wss（connect-src 'self' に当たらなかったのが分かるように）
            blocked: `self:wss/h/:id/ws`,
        });
    });

    it('effective-directive がない古い形は violated-directive の最初の語', () => {
        const report = legacy({ 'effective-directive': undefined, 'violated-directive': "style-src 'self'" });
        expect(parseViolation(report, ORIGIN)?.directive).toBe('style-src');
    });

    it('ほかのオリジンの画面の報告・形が違うものは読まない', () => {
        expect(parseViolation(legacy({ 'document-uri': 'https://evil.example/' }), ORIGIN)).toBeNull();
        expect(parseViolation(modern({ documentURL: 'not a url' }), ORIGIN)).toBeNull();
        expect(parseViolation({ type: 'deprecation', body: {} }, ORIGIN)).toBeNull();
        expect(parseViolation('x', ORIGIN)).toBeNull();
        expect(parseViolation(null, ORIGIN)).toBeNull();
    });

    it('知らない値は other にする（長い・形の違うディレクティブ、知らない disposition）', () => {
        const v = parseViolation(legacy({ 'effective-directive': 'SCRIPT SRC; drop', disposition: 'x' }), ORIGIN);
        expect(v?.directive).toBe('other');
        expect(v?.disposition).toBe('other');
    });

    it('読み込もうとしたもの: 種類の言葉、ほかのオリジンはオリジンと伏せたパス、data: などは scheme だけ', () => {
        expect(blockedOf('eval', ORIGIN)).toBe('eval');
        expect(blockedOf('wasm-eval', ORIGIN)).toBe('wasm-eval');
        expect(blockedOf('data', ORIGIN)).toBe('data');
        expect(blockedOf('data:image/png;base64,SECRET', ORIGIN)).toBe('data');
        expect(blockedOf('blob:https://rw-dev.example/abc', ORIGIN)).toBe('blob');
        expect(blockedOf('https://cdn.example/lib/secret-project-name.js?k=SECRET', ORIGIN)).toBe(
            'https://cdn.example/:v/:id',
        );
        expect(blockedOf(`${ORIGIN}/h/${HOST}/api/projects/meetings`, ORIGIN)).toBe('self/h/:id/api/projects/:v');
        expect(blockedOf('', ORIGIN)).toBe('none');
        expect(blockedOf('not a url', ORIGIN)).toBe('other');
    });

    it('画面のパスは router.ts の区切りだけ残す', () => {
        expect(screenPath('/')).toBe('/');
        expect(screenPath(`/p/${SESSION}/new`)).toBe('/p/:id/new');
        expect(screenPath('/pair')).toBe('/pair');
        expect(screenPath('/some-project-name')).toBe('/:id');
        expect(screenPath('/meetings')).toBe('/:v');
    });
});

describe('書く行', () => {
    it('同じ違反はまとめて件数にし、並びは表のとおり。抜粋・クエリ・ポリシーは入らない', () => {
        const v = parseViolation(legacy(), ORIGIN);
        const w = parseViolation(modern(), ORIGIN);
        const points = cspDataPoints([v!, v!, w!], SAFARI_IOS);
        expect(points).toHaveLength(2);
        expect(points[0]).toEqual({
            blobs: ['csp', 'script-src-elem', 'enforce', '/s/:id', 'inline', 'safari', 'ios'],
            doubles: [2],
            indexes: ['csp'],
        });
        expect(points[1].doubles).toEqual([1]);
        const text = JSON.stringify(points);
        for (const secret of ['SECRET', SESSION, HOST, "'self'", 'frag']) {
            expect(text).not.toContain(secret);
        }
    });

    it(`1 回で書くのは ${MAX_POINTS} 行まで`, () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            directive: `d${'abcdefghijklmnopqrstuvwxyzabcd'[i]}`,
            disposition: 'enforce' as const,
            page: '/',
            blocked: 'inline',
        }));
        expect(cspDataPoints(many, '')).toHaveLength(MAX_POINTS);
    });
});

describe('POST /csp-report', () => {
    it('ログインなしで受けて 204。両方の形・配列のまとめ送りを読む', async () => {
        const { points, env: e } = fakeEnv();
        const one = await handleCspReport(post(JSON.stringify(legacy())), e);
        expect(one.status).toBe(204);
        const batch = await handleCspReport(
            post(JSON.stringify([modern(), modern(), { type: 'intervention', body: {} }]), {
                'Content-Type': 'application/reports+json',
            }),
            e,
        );
        expect(batch.status).toBe(204);
        expect(points.map((p) => [p.blobs[1], p.doubles[0]])).toEqual([
            ['script-src-elem', 1],
            ['connect-src', 2],
        ]);
    });

    it('JSON でないもの・ほかのオリジンのものは黙って捨てる', async () => {
        const { points, env: e } = fakeEnv();
        expect((await handleCspReport(post('not json'), e)).status).toBe(204);
        const other = legacy({ 'document-uri': 'https://evil.example/x' });
        expect((await handleCspReport(post(JSON.stringify(other)), e)).status).toBe(204);
        expect(points).toHaveLength(0);
    });

    it('大きすぎる本文は 413（Content-Length がなくても読みながら止める）', async () => {
        const { points, env: e } = fakeEnv();
        const big = JSON.stringify([modern({ sample: 'x'.repeat(MAX_BODY_BYTES) })]);
        expect((await handleCspReport(post(big), e)).status).toBe(413);
        const stream = new ReadableStream({
            start(c) {
                c.enqueue(new TextEncoder().encode(big));
                c.close();
            },
        });
        const chunked = new Request(`${ORIGIN}/csp-report`, { method: 'POST', body: stream });
        expect((await handleCspReport(chunked, e)).status).toBe(413);
        expect(points).toHaveLength(0);
    });

    it('接続元ごとの回数を超えたら 429 で、書かない。IP は鍵にするだけ', async () => {
        let n = 0;
        const { points, keys, env: e } = fakeEnv(() => ++n <= 1);
        const headers = { 'CF-Connecting-IP': '203.0.113.7' };
        expect((await handleCspReport(post(JSON.stringify(legacy()), headers), e)).status).toBe(204);
        expect((await handleCspReport(post(JSON.stringify(legacy()), headers), e)).status).toBe(429);
        expect(keys).toEqual(['csp:203.0.113.7', 'csp:203.0.113.7']);
        expect(points).toHaveLength(1);
        expect(JSON.stringify(points)).not.toContain('203.0.113.7');
    });

    it('回数の制限を確かめられないときは受けない', async () => {
        const { points, env: e } = fakeEnv(() => {
            throw new Error('down');
        });
        expect((await handleCspReport(post(JSON.stringify(legacy())), e)).status).toBe(429);
        expect(points).toHaveLength(0);
    });

    it('POST 以外は 405', async () => {
        const { env: e } = fakeEnv();
        expect((await handleCspReport(new Request(`${ORIGIN}/csp-report`), e)).status).toBe(405);
    });

    it('Worker が答える（静的アセットに行かない）。セキュリティのヘッダーも付き、HTTP の計測では csp として数える', async () => {
        const res = await SELF.fetch(`${ORIGIN}/csp-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/csp-report', 'CF-Connecting-IP': '198.51.100.1' },
            body: JSON.stringify(legacy()),
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        const { points, env: e } = fakeEnv();
        await worker.fetch(post(JSON.stringify(legacy())) as Parameters<typeof worker.fetch>[0], e);
        // 報告の 1 行と、HTTP の計測の 1 行
        expect(points).toHaveLength(2);
        const http = points.find((p) => p.blobs[1] === 'POST');
        expect(http?.blobs.slice(0, 3)).toEqual(['csp', 'POST', '/csp-report']);
    });

    it('wrangler.jsonc の回数の制限が効く（1 分に 20 回）', async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 22; i++) {
            const res = await SELF.fetch(`${ORIGIN}/csp-report`, {
                method: 'POST',
                headers: { 'CF-Connecting-IP': '198.51.100.99' },
                body: '{}',
            });
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
        expect(statuses.slice(20)).toEqual([429, 429]);
    });
});
