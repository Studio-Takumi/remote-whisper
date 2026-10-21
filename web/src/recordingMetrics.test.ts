import { describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@/protocol';
import {
    RecordingMetrics,
    median,
    percentile,
    recordedSeconds,
    sendRecordingMetrics,
    summarizeRtt,
} from '@/recordingMetrics';

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
}

const status = (over: Partial<Extract<ServerMessage, { type: 'status' }>> = {}): ServerMessage => ({
    type: 'status',
    whisper: 'ready',
    ollama: 'ready',
    recordings: 1,
    queue: 0,
    ...over,
});

describe('集計の関数', () => {
    it('中央値・90%・最大', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([1, 2, 3, 4])).toBe(2);
        expect(percentile([], 0.9)).toBeUndefined();
        const samples = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
        expect(summarizeRtt(samples)).toEqual({ rttP50Ms: 50, rttP90Ms: 90, rttMaxMs: 100 });
        expect(summarizeRtt([])).toEqual({});
    });

    it('録音した秒数は、サンプル数から数える（一時停止の分は入らない）', () => {
        expect(recordedSeconds(16000 * 90 + 5, 16000)).toBe(90);
    });
});

describe('RecordingMetrics', () => {
    it('ack の往復を送った時刻との差から出す', () => {
        const c = clock();
        const m = new RecordingMetrics({ now: c.now });
        m.chunkSent(0, 1);
        m.chunkSent(1, 2);
        c.advance(100);
        m.ack(0);
        c.advance(300);
        m.ack(1);
        const p = m.take('h');
        expect(p).toMatchObject({ chunksSent: 2, chunksAcked: 2, rttP50Ms: 100, rttP90Ms: 400, rttMaxMs: 400 });
        expect(p?.maxBufferedSec).toBe(2);
    });

    it('一時停止の回数・秒数、再接続、切れていた秒数', () => {
        const c = clock();
        const m = new RecordingMetrics({ now: c.now, continued: true });
        m.pause();
        m.pause();
        m.connection(false);
        c.advance(5000);
        m.connection(true);
        m.stop(120);
        expect(m.take('h')).toMatchObject({
            recordingSec: 120,
            pauses: 2,
            reconnects: 1,
            offlineSec: 5,
            continued: true,
            upload: false,
        });
    });

    it('文字起こし・要約・ホストの状態を集める', () => {
        const c = clock();
        const m = new RecordingMetrics({ now: c.now });
        c.advance(7000);
        m.receive({ type: 'final', session: 's', segment: 0, start: 0, end: 1, text: '本文は送らない' }, 's');
        m.receive({ type: 'partial', session: 's', segment: 1, committed: 'a', tentative: 'b' }, 's');
        m.receive({ type: 'transcriptionStalled', session: 's', stalled: true }, 's');
        m.receive({ type: 'transcriptionStalled', session: 's', stalled: true }, 's');
        m.receive({ type: 'summary.done', session: 's', kind: 'live' }, 's');
        m.receive(
            status({
                gpu: { util: 20, memUsedMb: 1000, memTotalMb: 8000 },
                jobs: {
                    running: { kind: 'transcribe', session: 's', runningSec: 1 },
                    waiting: [{ kind: 'terms', session: 's', count: 2, waitingSec: 1 }],
                },
            }),
            's',
        );
        m.receive(
            status({ gpu: { util: 60, memUsedMb: 3000, memTotalMb: 8000 }, whisper: 'error', ollama: 'error' }),
            's',
        );
        m.receive(status({ whisper: 'error' }), 's');
        m.receive({ type: 'error', code: 'write_failed', message: '秘密の文面' }, 's');
        m.receive({ type: 'error', session: 'other', code: 'bad_message', message: 'x' }, 's');
        c.advance(3000);
        m.stop(30);
        c.advance(4000);
        m.receive({ type: 'finalTranscript', session: 's', generationId: 'g' }, 's');
        c.advance(6000);
        m.finalSummaryDone();
        const p = m.take('h');
        expect(p).toMatchObject({
            partials: 1,
            finals: 1,
            firstFinalSec: 7,
            stalls: 1,
            liveSummaries: 1,
            gpuQueueMax: 3,
            gpuUtilAvg: 40,
            gpuUtilMax: 60,
            vramMaxMb: 3000,
            whisperDown: 1,
            ollamaDown: 1,
            finalTranscriptSec: 4,
            finalSummarySec: 10,
            errors: { write_failed: 1 },
        });
        // 本文・文面は入らない
        expect(JSON.stringify(p)).not.toMatch(/本文は送らない|秘密の文面/);
    });

    it('同じ録音は 2 回取れない。使った設定が入る', () => {
        const m = new RecordingMetrics({
            settings: {
                whisperModel: 'large-v3-turbo',
                summaryModel: 'qwen3.5:4b',
                overviewModel: 'qwen3.5:4b',
                noiseSuppression: true,
                autoGainControl: false,
                echoCancellation: true,
            },
        });
        expect(m.take('h')).toMatchObject({ hostId: 'h', whisperModel: 'large-v3-turbo', autoGainControl: false });
        expect(m.take('h')).toBeNull();
    });
});

describe('送る', () => {
    const url = '/me/metrics/recording';

    it('ダイレクト版では送らない（本文も作らない）', () => {
        const fetchFn = vi.fn();
        const sendBeacon = vi.fn();
        const m = new RecordingMetrics();
        expect(sendRecordingMetrics(m, { cloud: false, hostId: 'h', url, fetchFn: fetchFn as never })).toBe(false);
        expect(sendRecordingMetrics(m, { cloud: false, hostId: 'h', url, beacon: true, sendBeacon })).toBe(false);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(sendBeacon).not.toHaveBeenCalled();
        expect(m.take('h')).not.toBeNull();
    });

    it('クラウド版では 1 回だけ POST する', () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        const m = new RecordingMetrics();
        expect(sendRecordingMetrics(m, { cloud: true, hostId: 'h', url, fetchFn })).toBe(true);
        expect(sendRecordingMetrics(m, { cloud: true, hostId: 'h', url, fetchFn })).toBe(false);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [calledUrl, init] = fetchFn.mock.calls[0];
        expect(calledUrl).toBe(url);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body).hostId).toBe('h');
    });

    it('ページを閉じるときは sendBeacon で送る。ホストがなければ送らない', () => {
        const sendBeacon = vi.fn().mockReturnValue(true);
        expect(
            sendRecordingMetrics(new RecordingMetrics(), { cloud: true, hostId: null, url, beacon: true, sendBeacon }),
        ).toBe(false);
        expect(
            sendRecordingMetrics(new RecordingMetrics(), { cloud: true, hostId: 'h', url, beacon: true, sendBeacon }),
        ).toBe(true);
        expect(sendBeacon).toHaveBeenCalledTimes(1);
    });
});
