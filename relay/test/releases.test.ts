// 最新のリリース（#472）。GitHub の一覧から正式なリリースを選び、1 時間キャッシュし、確かめに来た版と ID だけを書く
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import {
    GITHUB_RELEASES_URL,
    ID_HEADER,
    VERSION_HEADER,
    cacheKey,
    pickLatest,
    updateCheckDataPoint,
} from '../src/releases';

const ORIGIN = 'https://rw-dev.example';
const ID = '11111111-2222-4333-8444-555555555555';
const PAGE = 'https://github.com/Studio-Takumi/remote-whisper/releases/tag/';

function release(tag: string, extra: Record<string, unknown> = {}) {
    return {
        tag_name: tag,
        html_url: PAGE + tag,
        draft: false,
        prerelease: false,
        published_at: '2026-11-20T00:00:00Z',
        ...extra,
    };
}

let spy: ReturnType<typeof vi.spyOn>;
let github: () => Response;

beforeEach(async () => {
    await caches.default.delete(cacheKey(new Request(ORIGIN)));
    github = () => Response.json([release('v1.1.0'), release('v1.0.2')]);
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== GITHUB_RELEASES_URL) {
            throw new Error(`unexpected fetch: ${url}`);
        }
        return github();
    });
});

afterEach(() => {
    spy.mockRestore();
});

function recorder() {
    const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
    const metrics = { writeDataPoint: (p: (typeof points)[number]) => points.push(p) };
    return { points, env: { ...env, METRICS: metrics } as unknown as Env };
}

function check(headers: Record<string, string> = {}, e: Env = env) {
    return worker.fetch(new Request(`${ORIGIN}/releases/latest`, { headers }), e);
}

describe('一覧から選ぶ', () => {
    it('下書き・プレリリース・-rc などの付いたタグは除き、数字で一番新しいもの', () => {
        expect(
            pickLatest([
                release('v2.0.0-rc.1'),
                release('v1.10.0', { prerelease: true }),
                release('v1.9.0', { draft: true }),
                release('v1.2.0'),
                release('v1.10.0+build'),
                release('v1.3.0', { html_url: 'https://evil.example/' }),
            ]),
        ).toEqual({ version: 'v1.2.0', url: `${PAGE}v1.2.0`, publishedAt: '2026-11-20T00:00:00Z' });
        expect(pickLatest([release('v1.9.0'), release('v1.10.0')])?.version).toBe('v1.10.0');
        expect(pickLatest([])).toBeNull();
        expect(pickLatest({ message: 'Not Found' })).toBeNull();
    });
});

describe('GET /releases/latest', () => {
    it('最新を返す。GitHub には User-Agent を付けて聞く', async () => {
        const res = await SELF.fetch(`${ORIGIN}/releases/latest`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            version: 'v1.1.0',
            url: `${PAGE}v1.1.0`,
            publishedAt: '2026-11-20T00:00:00Z',
        });
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('User-Agent')).toBeTruthy();
    });

    it('1 時間はキャッシュから返し、GitHub に聞き直さない', async () => {
        expect((await check()).status).toBe(200);
        github = () => Response.json([release('v9.0.0')]);
        const res = await check();
        expect(((await res.json()) as { version: string }).version).toBe('v1.1.0');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });

    it('GitHub に届かない・断られたら 502（5 分キャッシュ）、リリースがなければ 404', async () => {
        github = () => {
            throw new Error('network');
        };
        const failed = await check();
        expect(failed.status).toBe(502);
        expect(failed.headers.get('Cache-Control')).toBe('public, max-age=300');

        await caches.default.delete(cacheKey(new Request(ORIGIN)));
        github = () => new Response('rate limited', { status: 403 });
        expect((await check()).status).toBe(502);

        await caches.default.delete(cacheKey(new Request(ORIGIN)));
        github = () => Response.json([release('v1.0.0-rc.1')]);
        expect((await check()).status).toBe(404);
    });

    it('502 もキャッシュから返し、5 分のあいだは GitHub に聞き直さない', async () => {
        github = () => new Response('rate limited', { status: 403 });
        expect((await check()).status).toBe(502);
        github = () => Response.json([release('v1.1.0')]);
        expect((await check()).status).toBe(502);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('HEAD にも答える。GET・HEAD のほかは 405', async () => {
        const head = await worker.fetch(new Request(`${ORIGIN}/releases/latest`, { method: 'HEAD' }), env);
        expect(head.status).toBe(200);
        const res = await worker.fetch(new Request(`${ORIGIN}/releases/latest`, { method: 'POST' }), env);
        expect(res.status).toBe(405);
    });
});

describe('確かめに来たことを書く', () => {
    it('種類とホストの版、ID だけを 1 行書く（国や IP は書かない）', async () => {
        const { points, env: e } = recorder();
        const request = new Request(`${ORIGIN}/releases/latest`, {
            headers: {
                [VERSION_HEADER]: 'v1.0.0+34a7607.dirty',
                [ID_HEADER]: ID.toUpperCase(),
                'CF-Connecting-IP': '203.0.113.9',
            },
            cf: { country: 'JP' },
        } as unknown as RequestInit) as unknown as Request<unknown, IncomingRequestCfProperties>;
        expect((await worker.fetch(request, e)).status).toBe(200);
        const rows = points.filter((p) => p.blobs[0] === 'update_check');
        expect(rows).toEqual([{ blobs: ['update_check', 'v1.0.0+34a7607.dirty'], doubles: [], indexes: [ID] }]);
        expect(JSON.stringify(rows)).not.toMatch(/JP|203\.0\.113\.9/);
        // キャッシュから返すときも書く
        await worker.fetch(
            new Request(`${ORIGIN}/releases/latest`, { headers: { [VERSION_HEADER]: 'v1.0.0', [ID_HEADER]: ID } }),
            e,
        );
        expect(points.filter((p) => p.blobs[0] === 'update_check')).toHaveLength(2);
    });

    it('ID が UUID でない・版の形が違う・どちらかがないときは書かない（応答は返す）', async () => {
        const { points, env: e } = recorder();
        const cases: Record<string, string>[] = [
            { [VERSION_HEADER]: 'v1.0.0', [ID_HEADER]: 'not-a-uuid' },
            { [VERSION_HEADER]: 'v1.0.0 <script>', [ID_HEADER]: ID },
            { [VERSION_HEADER]: 'x'.repeat(33), [ID_HEADER]: ID },
            { [VERSION_HEADER]: 'v1.0.0' },
            { [ID_HEADER]: ID },
            {},
        ];
        for (const headers of cases) {
            expect((await check(headers, e)).status).toBe(200);
        }
        expect(points.filter((p) => p.blobs[0] === 'update_check')).toHaveLength(0);
        expect(
            updateCheckDataPoint(new Request(ORIGIN, { headers: { [VERSION_HEADER]: 'unknown', [ID_HEADER]: ID } })),
        ).not.toBeNull();
    });

    it('書けなくても応答は返す。HTTP の計測の行には ID も版も入らない', async () => {
        const points: { blobs: string[] }[] = [];
        const metrics = {
            writeDataPoint: (p: { blobs: string[] }) => {
                if (p.blobs[0] === 'update_check') {
                    throw new Error('quota');
                }
                points.push(p);
            },
        };
        const e = { ...env, METRICS: metrics } as unknown as Env;
        const res = await check({ [VERSION_HEADER]: 'v1.0.0', [ID_HEADER]: ID }, e);
        expect(res.status).toBe(200);
        expect(points).toHaveLength(1);
        expect(points[0].blobs.slice(0, 3)).toEqual(['releases', 'GET', '/releases/latest']);
        expect(JSON.stringify(points[0])).not.toContain(ID);
        expect(JSON.stringify(points[0])).not.toContain('v1.0.0');
    });
});
