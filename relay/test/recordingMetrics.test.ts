// 録音ごとの数字（#206）。許可リストにない項目・本文らしい文字列・他人のホスト ID が書かれないこと
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/http';
import type { Env } from '../src/index';
import {
    HOST_NUMBERS,
    MAX_BODY_BYTES,
    RATE_LIMIT,
    RECORDING_NUMBERS,
    postRecordingMetrics,
    recordingDataPoints,
    sanitizeRecording,
} from '../src/recordingMetrics';

const ORIGIN = 'https://rw-dev.example';
const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function newUser() {
    const userId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const hostId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, 'たろう', now),
        env.DB.prepare(
            'INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + 3_600_000, now),
        env.DB.prepare('INSERT INTO hosts (id, user_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)').bind(
            hostId,
            userId,
            'pc',
            'pk',
            now,
        ),
    ]);
    return { userId, hostId, cookie: `__Host-rw_session=${token}` };
}

function post(body: unknown, cookie?: string, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC };
    if (cookie) {
        headers.Cookie = cookie;
    }
    if (origin) {
        headers.Origin = origin;
    }
    return SELF.fetch(`${ORIGIN}/me/metrics/recording`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

// 書いた行を集める束縛
function recorder() {
    const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
    const metrics = { writeDataPoint: (p: (typeof points)[number]) => points.push(p) };
    return { points, env: { ...env, METRICS: metrics } as unknown as Env };
}

function direct(env: Env, userId: string, body: unknown, bytes?: string) {
    return postRecordingMetrics(
        new Request(`${ORIGIN}/me/metrics/recording`, {
            method: 'POST',
            headers: { 'User-Agent': CHROME_MAC },
            body: bytes ?? JSON.stringify(body),
        }),
        env,
        userId,
    );
}

describe('許可リスト', () => {
    it('知らない項目は捨てる', () => {
        const clean = sanitizeRecording({
            recordingSec: 60,
            transcript: 'こんにちは',
            sessionId: '2026-10-20_1',
            x: 1,
        });
        expect(clean).toEqual({ numbers: { recordingSec: 60 }, flags: {}, strings: {}, errors: {} });
    });

    it('数値は有限で 0 以上・上限以下だけ通す', () => {
        const clean = sanitizeRecording({
            recordingSec: 86_401,
            pauses: -1,
            rttMaxMs: Number.NaN,
            finals: '5',
            partials: 100_000,
            reconnects: Infinity,
            gpuUtilMax: 100,
            chunksSent: 0,
        });
        expect(clean.numbers).toEqual({ partials: 100_000, gpuUtilMax: 100, chunksSent: 0 });
    });

    it('文字列は決まった形のモデル名だけ。空白を含むもの・長いもの・本文らしいものは捨てる', () => {
        const clean = sanitizeRecording({
            whisperModel: 'large-v3-turbo',
            summaryModel: 'qwen3.5:4b',
            overviewModel: 'これは文字起こしの本文です',
        });
        expect(clean.strings).toEqual({ whisperModel: 'large-v3-turbo', summaryModel: 'qwen3.5:4b' });
        for (const bad of ['hello world', 'a'.repeat(65), 'Upper', '-x', '', 'a\nb', 123, null]) {
            expect(sanitizeRecording({ whisperModel: bad }).strings).toEqual({});
        }
        expect(sanitizeRecording({ whisperModel: 'a'.repeat(64) }).strings.whisperModel).toBeDefined();
    });

    it('真偽はそのまま、真偽でないものは捨てる', () => {
        const clean = sanitizeRecording({
            upload: true,
            continued: false,
            noiseSuppression: 'true',
            autoGainControl: 1,
        });
        expect(clean.flags).toEqual({ upload: true, continued: false });
    });

    it('error の code は形が合うものだけ、10 種類まで', () => {
        const errors: Record<string, number> = { write_failed: 2, 'Bad Code': 1, こんにちは: 1, x1: 1, neg: -1 };
        for (let i = 0; i < 20; i++) {
            errors[`code_${'abcdefghijklmnopqrst'[i]}`] = 1;
        }
        const clean = sanitizeRecording({ errors });
        expect(clean.errors.write_failed).toBe(2);
        expect(Object.keys(clean.errors).every((c) => /^[a-z_]{1,32}$/.test(c))).toBe(true);
        expect(Object.keys(clean.errors).length).toBe(10);
        expect(sanitizeRecording({ errors: ['a'] }).errors).toEqual({});
    });
});

describe('書く行', () => {
    it('2 行（録音・ホスト）で、並びは表のとおり。本文らしい文字列・ほかの項目は入らない', () => {
        const secret = 'TOPSECRET-transcript';
        const clean = sanitizeRecording({
            recordingSec: 61.5,
            pauses: 2,
            rttP50Ms: 120,
            gpuUtilAvg: 40,
            upload: true,
            echoCancellation: true,
            whisperModel: 'large-v3-turbo',
            overviewModel: secret,
            title: secret,
            errors: { write_failed: 1, ollama_unavailable: 2 },
        });
        const [rec, host] = recordingDataPoints(clean, {
            userId: 'u1',
            hostId: 'h1',
            userAgent: CHROME_MAC,
            key: 'k1',
        });
        expect(rec.blobs).toEqual(['recording', 'chrome', 'macos', 'u1', 'h1', 'large-v3-turbo', '', '', '', 'k1']);
        expect(rec.doubles).toEqual([1 + 16, 61.5, 2, 120, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
        expect(host.blobs).toEqual([
            'recording_host',
            'chrome',
            'macos',
            'u1',
            'h1',
            'large-v3-turbo',
            '',
            '',
            'ollama_unavailable:2,write_failed:1',
            'k1',
        ]);
        // 末尾の 3 つは recordingSec・reconnects・offlineSec の写し
        expect(host.doubles).toEqual([1 + 16, -1, -1, -1, -1, 40, -1, -1, -1, -1, 61.5, -1, -1]);
        expect(rec.doubles.length).toBe(1 + Object.keys(RECORDING_NUMBERS).length);
        expect(host.doubles.length).toBe(1 + Object.keys(HOST_NUMBERS).length + 3);
        expect(rec.indexes).toEqual(['u1']);
        expect(JSON.stringify([rec, host])).not.toContain(secret);
    });
});

describe('POST /me/metrics/recording', () => {
    it('ログインしていなければ 401、Origin が違えば 403', async () => {
        expect((await post({ hostId: 'x' })).status).toBe(401);
        const { cookie, hostId } = await newUser();
        expect((await post({ hostId }, cookie, 'https://evil.example')).status).toBe(403);
        expect((await post({ hostId }, cookie, null)).status).toBe(403);
    });

    it('束縛がなくても 204', async () => {
        const { cookie, hostId } = await newUser();
        expect((await post({ hostId, recordingSec: 10 }, cookie)).status).toBe(204);
        expect((await post('not json', cookie)).status).toBe(204);
    });

    it('自分のホストなら 2 行書き、他人のホスト・知らないホストは書かない', async () => {
        const me = await newUser();
        const other = await newUser();
        const { points, env: fake } = recorder();
        expect((await direct(fake, me.userId, { hostId: me.hostId, recordingSec: 5 })).status).toBe(204);
        expect(points.length).toBe(2);
        expect(points[0].blobs.slice(0, 5)).toEqual(['recording', 'chrome', 'macos', me.userId, me.hostId]);

        points.length = 0;
        await direct(fake, me.userId, { hostId: other.hostId, recordingSec: 5 });
        await direct(fake, me.userId, { hostId: crypto.randomUUID(), recordingSec: 5 });
        await direct(fake, me.userId, { recordingSec: 5 });
        await direct(fake, me.userId, [1, 2]);
        expect(points).toEqual([]);

        // 解除したホストも書かない
        await env.DB.prepare('DELETE FROM hosts WHERE id = ?').bind(me.hostId).run();
        await direct(fake, me.userId, { hostId: me.hostId });
        expect(points).toEqual([]);
    });

    it('2 行は録音ごとの同じ鍵で結ばれ、録音が違えば鍵も違う', async () => {
        const me = await newUser();
        const { points, env: fake } = recorder();
        await direct(fake, me.userId, { hostId: me.hostId });
        await direct(fake, me.userId, { hostId: me.hostId });
        expect(points[0].blobs[9]).toBe(points[1].blobs[9]);
        expect(points[2].blobs[9]).toBe(points[3].blobs[9]);
        expect(points[0].blobs[9]).not.toBe(points[2].blobs[9]);
        expect(points[0].blobs[9]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('Content-Length がなくても、8KB を超えたら 413', async () => {
        const { env: fake, points } = recorder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"x":"' + 'x'.repeat(MAX_BODY_BYTES)));
                controller.close();
            },
        });
        const request = new Request(`${ORIGIN}/me/metrics/recording`, {
            method: 'POST',
            body: stream,
            duplex: 'half',
        } as RequestInit);
        const res = await postRecordingMetrics(request, fake, (await newUser()).userId);
        expect(res.status).toBe(413);
        expect(points).toEqual([]);
    });

    it('本文は 8KB まで', async () => {
        const { cookie, hostId, userId } = await newUser();
        const big = JSON.stringify({ hostId, recordingSec: 1, pad: 'x'.repeat(MAX_BODY_BYTES) });
        expect((await post(big, cookie)).status).toBe(413);
        const { points, env: fake } = recorder();
        expect((await direct(fake, userId, null, big)).status).toBe(413);
        expect(points).toEqual([]);
    });

    it('1 時間に 60 件まで。超えたら 429、別のユーザーには影響しない', async () => {
        const a = await newUser();
        const b = await newUser();
        for (let i = 0; i < RATE_LIMIT; i++) {
            expect((await post({ hostId: a.hostId }, a.cookie)).status).toBe(204);
        }
        expect((await post({ hostId: a.hostId }, a.cookie)).status).toBe(429);
        expect((await post({ hostId: b.hostId }, b.cookie)).status).toBe(204);
        // 429 のときは書かない
        const { points, env: fake } = recorder();
        expect((await direct(fake, a.userId, { hostId: a.hostId, recordingSec: 1 })).status).toBe(429);
        expect(points).toEqual([]);
        // 1 時間より前の分は数えない
        await env.DB.prepare('UPDATE recording_metric_posts SET posted_at = ? WHERE user_id = ?')
            .bind(Date.now() - 3_600_001, a.userId)
            .run();
        expect((await post({ hostId: a.hostId }, a.cookie)).status).toBe(204);
    });
});
