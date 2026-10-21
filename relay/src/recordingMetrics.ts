// 録音ごとの数字（#206。spec/cloud.md 10.9）。クラウド版の画面が録音 1 回につき 1 回送ってくる数字を、
// 許可リストで確かめて、Analytics Engine に書く。送られる数字は偽れる前提で扱う
//
// - 書くもの: 許可リストの数値・真偽・決まった形の文字列だけ。知らない項目は捨てる
// - 書かないもの: 音声、文字起こし・要約・タイトル・用語の本文、プロジェクト名・ファイル名、error の文面、セッション ID、IP アドレス
import { error } from './http';
import type { Env } from './index';
import { browserOf, osOf } from './metrics';

export const MAX_BODY_BYTES = 8 * 1024;
// 1 ユーザーあたり、1 時間に受け付ける件数
export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

const DAY_SEC = 86_400;
const COUNT = 100_000;

// 数値の項目（名前は画面が送るものと同じ）と、受け付ける上限。有限の数で 0 以上のものだけ通す。
// 1 行に書ける数値は 20 個までなので、録音（recording）とホスト・要約（recording_host）の 2 行に分けて書く
export const RECORDING_NUMBERS = {
    recordingSec: DAY_SEC,
    pauses: COUNT,
    rttP50Ms: 3_600_000,
    rttP90Ms: 3_600_000,
    rttMaxMs: 3_600_000,
    chunksSent: COUNT,
    chunksAcked: COUNT,
    reconnects: COUNT,
    offlineSec: DAY_SEC,
    maxBufferedSec: DAY_SEC,
    partials: COUNT,
    finals: COUNT,
    firstFinalSec: DAY_SEC,
    stalls: COUNT,
} as const;

export const HOST_NUMBERS = {
    liveSummaries: COUNT,
    finalSummarySec: DAY_SEC,
    finalTranscriptSec: DAY_SEC,
    gpuQueueMax: 1000,
    gpuUtilAvg: 100,
    gpuUtilMax: 100,
    vramMaxMb: 1_000_000,
    whisperDown: COUNT,
    ollamaDown: COUNT,
} as const;

// 真偽の項目。flags の下の位から、この順に 1・2・4・8・16
export const RECORDING_FLAGS = [
    'upload',
    'continued',
    'noiseSuppression',
    'autoGainControl',
    'echoCancellation',
    // 最終の要約を作れなかった・作ったか分からない（最終の要約の秒数は入れない）
    'summaryFailed',
] as const;

// 文字列の項目（モデル名など）。この形に合うものだけ通す。空白を含むもの・長いものは捨てる
export const RECORDING_STRINGS = ['whisperModel', 'summaryModel', 'overviewModel'] as const;
const STRING_FORMAT = /^[a-z0-9][a-z0-9.:_/-]{0,63}$/;
const ERROR_CODE = /^[a-z_]{1,32}$/;
const MAX_ERROR_CODES = 10;

type NumberKey = keyof typeof RECORDING_NUMBERS | keyof typeof HOST_NUMBERS;

export type RecordingMetrics = {
    numbers: Partial<Record<NumberKey, number>>;
    flags: Partial<Record<(typeof RECORDING_FLAGS)[number], boolean>>;
    strings: Partial<Record<(typeof RECORDING_STRINGS)[number], string>>;
    errors: Record<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 本文から、許可した項目だけを取り出す
export function sanitizeRecording(body: unknown): RecordingMetrics {
    const out: RecordingMetrics = { numbers: {}, flags: {}, strings: {}, errors: {} };
    if (!isRecord(body)) {
        return out;
    }
    const limits: Record<string, number> = { ...RECORDING_NUMBERS, ...HOST_NUMBERS };
    for (const [key, max] of Object.entries(limits)) {
        const v = body[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max) {
            out.numbers[key as NumberKey] = v;
        }
    }
    for (const key of RECORDING_FLAGS) {
        const v = body[key];
        if (typeof v === 'boolean') {
            out.flags[key] = v;
        }
    }
    for (const key of RECORDING_STRINGS) {
        const v = body[key];
        if (typeof v === 'string' && STRING_FORMAT.test(v)) {
            out.strings[key] = v;
        }
    }
    if (isRecord(body.errors)) {
        for (const [code, n] of Object.entries(body.errors)) {
            if (Object.keys(out.errors).length >= MAX_ERROR_CODES) {
                break;
            }
            if (ERROR_CODE.test(code) && typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= COUNT) {
                out.errors[code] = n;
            }
        }
    }
    return out;
}

export type RecordingDataPoint = { blobs: string[]; doubles: number[]; indexes: string[] };

function flagsOf(flags: RecordingMetrics['flags']): number {
    return RECORDING_FLAGS.reduce((bits, key, i) => bits + (flags[key] ? 1 << i : 0), 0);
}

// 書く 2 行を作る。blobs と doubles の並びは docs の表と合わせる（なかった数値は -1）
export function recordingDataPoints(
    clean: RecordingMetrics,
    who: { userId: string; hostId: string; userAgent: string; key: string },
): RecordingDataPoint[] {
    // 1 種類 2 ブラウザ 3 OS 4 ユーザー ID 5 ホスト ID 6 Whisper のモデル 7 要約のモデル 8 概要のモデル
    // 9 error の code ごとの件数 10 同じ録音の 2 行を結ぶ鍵（Worker が録音ごとに作る乱数。セッション ID とは無関係）
    const blobs = (kind: string, errors: string) => [
        kind,
        browserOf(who.userAgent),
        osOf(who.userAgent),
        who.userId,
        who.hostId,
        clean.strings.whisperModel ?? '',
        clean.strings.summaryModel ?? '',
        clean.strings.overviewModel ?? '',
        errors,
        who.key,
    ];
    const pick = (keys: string[]) => keys.map((k) => clean.numbers[k as NumberKey] ?? -1);
    const errors = Object.entries(clean.errors)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([code, n]) => `${code}:${n}`)
        .join(',');
    const flags = flagsOf(clean.flags);
    return [
        {
            blobs: blobs('recording', ''),
            doubles: [flags, ...pick(Object.keys(RECORDING_NUMBERS))],
            indexes: [who.userId],
        },
        {
            blobs: blobs('recording_host', errors),
            // 末尾の 3 つは、録音の行と突き合わせなくても「録音の長さ別」などで集計できるように写したもの
            doubles: [flags, ...pick(Object.keys(HOST_NUMBERS)), ...pick(['recordingSec', 'reconnects', 'offlineSec'])],
            indexes: [who.userId],
        },
    ];
}

// 1 時間に RATE_LIMIT 件まで。数えるのと足すのを 1 つの文にする（同時に来ても超えないように）
async function allowed(env: Env, userId: string): Promise<boolean> {
    const now = Date.now();
    await env.DB.prepare('DELETE FROM recording_metric_posts WHERE user_id = ? AND posted_at <= ?')
        .bind(userId, now - RATE_WINDOW_MS)
        .run();
    const res = await env.DB.prepare(
        `INSERT INTO recording_metric_posts (user_id, posted_at)
         SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM recording_metric_posts WHERE user_id = ?1) < ?3`,
    )
        .bind(userId, now, RATE_LIMIT)
        .run();
    return res.meta.changes > 0;
}

// 本文を MAX_BODY_BYTES まで読む。超えたら null（Content-Length がなくても、超えたところで読むのをやめる）
async function readLimited(request: Request): Promise<string | null> {
    if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY_BYTES) {
        return null;
    }
    if (!request.body) {
        return '';
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > MAX_BODY_BYTES) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
    }
    return new TextDecoder().decode(all);
}

// POST /me/metrics/recording。ログインと Origin は handleMe が確かめ済み。
// 受け取れないもの（形が違う・ほかの人のホスト・束縛がない）は、黙って捨てて 204 を返す
export async function postRecordingMetrics(request: Request, env: Env, userId: string): Promise<Response> {
    const text = await readLimited(request);
    if (text === null) {
        return error(413, '大きすぎます');
    }
    if (!(await allowed(env, userId))) {
        return error(429, '送りすぎです。しばらくしてからにしてください');
    }
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return new Response(null, { status: 204 });
    }
    const hostId = isRecord(body) && typeof body.hostId === 'string' ? body.hostId : '';
    // そのユーザーの（解除していない）ホストだけ
    const host = hostId
        ? await env.DB.prepare('SELECT id FROM hosts WHERE id = ? AND user_id = ?').bind(hostId, userId).first()
        : null;
    if (!host) {
        return new Response(null, { status: 204 });
    }
    try {
        const points = recordingDataPoints(sanitizeRecording(body), {
            userId,
            hostId,
            userAgent: request.headers.get('User-Agent') ?? '',
            key: crypto.randomUUID(),
        });
        for (const point of points) {
            env.METRICS?.writeDataPoint(point);
        }
    } catch (e) {
        console.warn(`failed to write a metric: ${(e as Error).message}`);
    }
    return new Response(null, { status: 204 });
}
