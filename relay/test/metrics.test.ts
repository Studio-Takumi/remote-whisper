// HTTP の計測（#163）。許可した項目だけを書き、本文・クエリ・IP は書かない
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/http';
import worker, { type Env } from '../src/index';
import { browserOf, httpDataPoint, normalizePath, osOf, recordHttp, rememberUser } from '../src/metrics';

const ORIGIN = 'https://rw-dev.example';
const HOST = '11111111-2222-4333-8444-555555555555';
const CHROME_WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

describe('パスの ID を伏せる', () => {
    it('UUID・数字・長い英数字は :id、見慣れない区切りは :v', () => {
        expect(normalizePath(`/h/${HOST}/api/projects/${HOST}/sessions/42`)).toBe('/h/:id/api/projects/:id/sessions');
        expect(normalizePath('/me/identities/abcdefghijklmnopqrstu')).toBe('/me/identities/:id');
        expect(normalizePath('/auth/callback/github')).toBe('/auth/callback/github');
        // 用語などの本文がパスに入っても、文字は残さない
        expect(normalizePath(`/h/${HOST}/api/terms/%E5%BF%83%E7%90%86`)).toBe('/h/:id/api/terms/:id');
        expect(normalizePath(`/h/${HOST}/api/terms/Kubernetes`)).toBe('/h/:id/api/terms/:v');
        // 許可リストにない語は、小文字でも残さない（プロジェクト ID はフォルダ名から作る）
        expect(normalizePath(`/h/${HOST}/api/projects/my-secret-lab`)).toBe('/h/:id/api/projects/:v');
        expect(normalizePath(`/h/${HOST}/api/terms/kubernetes`)).toBe('/h/:id/api/terms/:v');
        expect(normalizePath('/me/hosts/abc123')).toBe('/me/hosts/:v');
        // 短い日本語・7 つ以上の区切り・末尾のスラッシュ
        expect(normalizePath(`/h/${HOST}/api/terms/%E5%BF%83`)).toBe('/h/:id/api/terms/:v');
        expect(normalizePath('/me/a/b/c/d/e/f/g')).toBe('/me/:v/:v/:v/:v/:v');
        expect(normalizePath(`/h/${HOST}/`)).toBe('/h/:id/');
    });

    it('ブラウザと OS は大まかな種類だけ', () => {
        expect([browserOf(CHROME_WIN), osOf(CHROME_WIN)]).toEqual(['chrome', 'windows']);
        expect(browserOf('')).toBe('other');
        expect(osOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
    });
});

describe('書く 1 行', () => {
    it('許可した項目だけで、クエリ・IP・Cookie・本文は入らない', () => {
        const secret = 'TOPSECRET-transcript-text';
        const request = new Request(`${ORIGIN}/h/${HOST}/api/sessions/${HOST}?q=${secret}`, {
            method: 'POST',
            headers: {
                'User-Agent': CHROME_WIN,
                'CF-Connecting-IP': '203.0.113.9',
                Cookie: `__Host-rw_session=${secret}`,
                'Content-Length': '12',
            },
            body: `{"text":"${secret}"}`,
        });
        rememberUser(request, 'user-1');
        const response = new Response(`{"summary":"${secret}"}`, { status: 201, headers: { 'Content-Length': '30' } });
        const point = httpDataPoint(request, response, 12.4);
        expect(point.blobs).toEqual([
            'relay',
            'POST',
            '/h/:id/api/sessions/:id',
            'XX',
            'chrome',
            'windows',
            'user-1',
            HOST,
            'http',
        ]);
        expect(point.doubles).toEqual([201, 12, 12, 30]);
        expect(point.indexes).toEqual(['user-1']);
        const all = JSON.stringify(point);
        for (const banned of [secret, '203.0.113.9', '__Host-rw_session']) {
            expect(all).not.toContain(banned);
        }
    });

    it('WebSocket をつないだことと、ログインしていないことが分かる', () => {
        const request = new Request(`${ORIGIN}/h/${HOST}/ws`, { headers: { Upgrade: 'websocket' } });
        const point = httpDataPoint(request, new Response(null, { status: 403 }), 1);
        expect(point.blobs[8]).toBe('ws');
        expect(point.blobs[6]).toBe('');
        expect(point.indexes).toEqual(['relay']);
    });
});

describe('Worker の結線', () => {
    function fakeMetrics() {
        const points: { blobs?: string[]; doubles?: number[] }[] = [];
        const dataset = { writeDataPoint: (p: (typeof points)[number]) => points.push(p) };
        return { points, dataset: dataset as unknown as AnalyticsEngineDataset };
    }

    it('答えたものごとに 1 行書く。/healthz は書かない。ログインしていればユーザー ID が入る', async () => {
        const { points, dataset } = fakeMetrics();
        const e = { ...env, METRICS: dataset } as Env;
        await worker.fetch(new Request(`${ORIGIN}/healthz`), e);
        expect(points).toHaveLength(0);
        await worker.fetch(new Request(`${ORIGIN}/nope`), e);
        expect(points).toHaveLength(1);
        expect(points[0].blobs?.slice(0, 3)).toEqual(['other', 'GET', '/:v']);
        expect(points[0].doubles?.[0]).toBe(404);

        const userId = crypto.randomUUID();
        const token = crypto.randomUUID();
        const now = Date.now();
        await env.DB.batch([
            env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, 'x', now),
            env.DB.prepare(
                'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
            ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + 3_600_000, now),
        ]);
        const res = await worker.fetch(
            new Request(`${ORIGIN}/me`, { headers: { Cookie: `__Host-rw_session=${token}` } }),
            e,
        );
        expect(res.status).toBe(200);
        expect(points[1].blobs?.[6]).toBe(userId);
    });

    it('途中で例外になったら 500 として書き、例外はそのまま伝える', async () => {
        const { points, dataset } = fakeMetrics();
        const brokenDb = {
            prepare: () => {
                throw new Error('db down');
            },
        } as unknown as D1Database;
        const e = { ...env, DB: brokenDb, METRICS: dataset } as Env;
        await expect(
            worker.fetch(new Request(`${ORIGIN}/me`, { headers: { Cookie: '__Host-rw_session=x' } }), e),
        ).rejects.toThrow('db down');
        expect(points[0].doubles?.[0]).toBe(500);
    });

    it('国は 2 文字の英大文字だけ（T1 などは XX）', () => {
        const withCountry = (country: string) =>
            new Request(`${ORIGIN}/me`, { cf: { country } } as unknown as RequestInit);
        expect(httpDataPoint(withCountry('JP'), new Response(null), 1).blobs[3]).toBe('JP');
        expect(httpDataPoint(withCountry('T1'), new Response(null), 1).blobs[3]).toBe('XX');
    });
});

describe('書けなくても止まらない', () => {
    it('束縛がない・書くと例外になる、どちらでも投げない', () => {
        const request = new Request(`${ORIGIN}/me`);
        const response = new Response(null);
        expect(() => recordHttp({ ...env, METRICS: undefined } as Env, request, response, Date.now())).not.toThrow();
        const broken = {
            writeDataPoint: () => {
                throw new Error('quota');
            },
        } as unknown as AnalyticsEngineDataset;
        expect(() => recordHttp({ ...env, METRICS: broken } as Env, request, response, Date.now())).not.toThrow();
    });

    it('ローカル（束縛なし）でも、いつも通り答える', async () => {
        expect((await SELF.fetch(`${ORIGIN}/me`)).status).toBe(401);
        expect((await SELF.fetch(`${ORIGIN}/nope`)).status).toBe(404);
    });
});
