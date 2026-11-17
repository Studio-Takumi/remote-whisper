import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSettings } from '@/features/settings/settings';

const sent = vi.fn();

vi.mock('@/api/endpoint', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isCloud: true,
    getHostId: () => 'host-1',
    meUrl: (path: string) => path,
}));
vi.mock('@/features/recording/recordingMetrics', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    sendRecordingMetrics: (m: unknown, options: { beacon: boolean }) => sent(m, options.beacon),
}));

const { MetricsTracker } = await import('@/features/recording/metricsTracker');

beforeEach(() => {
    sent.mockClear();
});

describe('MetricsTracker', () => {
    it('録音を終えたものは、最終の要約ができたときに 1 回だけ送る', () => {
        const t = new MetricsTracker();
        t.start(false, 's1', 0, defaultSettings, null);
        t.stop('s1', 3.7);
        expect(sent).not.toHaveBeenCalled();
        t.finish('s1', true);
        t.finish('s1', false);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('途中で終わった録音は、すぐ送る（ほかのセッションなら送らない）', () => {
        const t = new MetricsTracker();
        t.start(false, 's1', 0, defaultSettings, null);
        t.interrupt('s2', 1);
        expect(sent).not.toHaveBeenCalled();
        t.interrupt('s1', 1);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('ページを閉じるときは、録音中のものと待っているものを beacon で送る', () => {
        const t = new MetricsTracker();
        t.awaitUpload('up', defaultSettings);
        t.start(false, 's1', 0, defaultSettings, null);
        t.sendAll(true, 2);
        expect(sent.mock.calls.map(([, beacon]) => beacon)).toEqual([true, true]);
        t.sendAll(false, 2);
        expect(sent).toHaveBeenCalledTimes(2);
    });
});
