// 最新のリリース（#472・#477）。relay 自身の版（APP_VERSION）から返し、確かめに来た版と ID だけを書く
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import { ID_HEADER, RELEASE_PAGE, VERSION_HEADER, latestFromAppVersion, updateCheckDataPoint } from '../src/releases';

const ORIGIN = 'https://rw-dev.example';
const ID = '11111111-2222-4333-8444-555555555555';

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    // 外には問い合わせない
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        throw new Error(`unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
    });
});

afterEach(() => {
    spy.mockRestore();
});

function withVersion(version: string | undefined, e: object = env): Env {
    return { ...e, APP_VERSION: version } as unknown as Env;
}

function recorder() {
    const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
    const metrics = { writeDataPoint: (p: (typeof points)[number]) => points.push(p) };
    return { points, env: { ...env, APP_VERSION: 'v1.1.0', METRICS: metrics } as unknown as Env };
}

function check(headers: Record<string, string> = {}, e: Env = withVersion('v1.1.0')) {
    return worker.fetch(new Request(`${ORIGIN}/releases/latest`, { headers }), e);
}

describe('relay 自身の版から作る', () => {
    it('vX.Y.Z の部分を取る（+ハッシュ・.dirty は落とす）', () => {
        const expected = { version: 'v1.1.0', url: `${RELEASE_PAGE}v1.1.0`, publishedAt: null };
        expect(latestFromAppVersion('v1.1.0')).toEqual(expected);
        expect(latestFromAppVersion('v1.1.0+abc1234')).toEqual(expected);
        expect(latestFromAppVersion('v1.1.0+abc1234.dirty')).toEqual(expected);
        expect(latestFromAppVersion('v1.10.0')?.version).toBe('v1.10.0');
    });

    it('ハッシュだけ・unknown・-rc・空・未設定は null', () => {
        for (const v of ['abc1234', 'abc1234+dirty', 'unknown', 'v1.1.0-rc.1', 'v1.1', 'x v1.1.0', '', undefined]) {
            expect(latestFromAppVersion(v)).toBeNull();
        }
    });
});

describe('GET /releases/latest', () => {
    it('relay の版が v1.1.0+abc1234 なら v1.1.0 とそのリリースノートの URL を返す。GitHub には聞かない', async () => {
        const res = await check({}, withVersion('v1.1.0+abc1234'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            version: 'v1.1.0',
            url: 'https://github.com/Studio-Takumi/remote-whisper/releases/tag/v1.1.0',
            publishedAt: null,
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('版がハッシュだけ・未設定なら 404', async () => {
        expect((await check({}, withVersion('abc1234'))).status).toBe(404);
        expect((await check({}, withVersion(undefined))).status).toBe(404);
        expect(spy).not.toHaveBeenCalled();
    });

    it('HEAD にも答える。GET・HEAD のほかは 405', async () => {
        const head = await worker.fetch(
            new Request(`${ORIGIN}/releases/latest`, { method: 'HEAD' }),
            withVersion('v1.1.0'),
        );
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
        // 版が取れなくて 404 のときも書く
        await worker.fetch(
            new Request(`${ORIGIN}/releases/latest`, { headers: { [VERSION_HEADER]: 'v1.0.0', [ID_HEADER]: ID } }),
            { ...e, APP_VERSION: undefined } as unknown as Env,
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
        const e = { ...env, APP_VERSION: 'v1.1.0', METRICS: metrics } as unknown as Env;
        const res = await check({ [VERSION_HEADER]: 'v1.0.0', [ID_HEADER]: ID }, e);
        expect(res.status).toBe(200);
        expect(points).toHaveLength(1);
        expect(points[0].blobs.slice(0, 3)).toEqual(['releases', 'GET', '/releases/latest']);
        expect(JSON.stringify(points[0])).not.toContain(ID);
        expect(JSON.stringify(points[0])).not.toContain('v1.0.0');
    });
});
