import { describe, expect, it } from 'vitest';

import { playableSources, recordingQuery, toMainTime, toSourceTime } from '@/features/session/sourcePlayback';
import type { SessionSource } from '@/features/session/sources';

describe('再生する音源の切り替え（#371）', () => {
    const main: SessionSource = { id: 1, name: null, kind: 'main', offsetSec: 0, driftPpm: 0 };
    const joined: SessionSource = {
        id: 2,
        name: 'iPhone',
        kind: 'join',
        offsetSec: 300,
        driftPpm: -50,
        joinedSec: 300,
        leftSec: 900,
    };
    const upload: SessionSource = { id: 3, name: 'b.m4a', kind: 'upload', offsetSec: -2.5, driftPpm: 0 };

    it('files.sourceRecordings がない古いサーバー・音源が 1 つ・選べるのが 1 つなら選ばせない', () => {
        expect(playableSources([main, joined], undefined)).toEqual([]);
        expect(playableSources([main], [1])).toEqual([]);
        expect(playableSources(undefined, [1, 2])).toEqual([]);
        expect(playableSources([main, joined, upload], [1])).toEqual([]);
        // 主の音源の録音がないと再生バーそのものを出さないので、選ばせない
        expect(playableSources([main, joined, upload], [2, 3])).toEqual([]);
        expect(playableSources([main, joined, upload], [1, 3])).toEqual([main, upload]);
    });

    it('主の音源は今までと同じ URL', () => {
        expect(recordingQuery(1)).toBe('');
        expect(recordingQuery(2)).toBe('?source=2');
    });

    it('主の音源の時刻と音源の時刻を、ずれとドリフトで行き来する', () => {
        expect(toSourceTime(42, main)).toBe(42);
        expect(toMainTime(42, main)).toBe(42);
        const sec = toSourceTime(600, joined);
        expect(sec).toBeCloseTo(300 / (1 + 50e-6), 6);
        expect(toMainTime(sec ?? 0, joined)).toBeCloseTo(600, 6);
        expect(toSourceTime(10, upload)).toBeCloseTo(12.5, 6);
        expect(toMainTime(12.5, upload)).toBeCloseTo(10, 6);
    });

    it('参加する前・抜けた後・ファイルの長さを超える時刻は null', () => {
        expect(toSourceTime(100, joined)).toBeNull();
        expect(toSourceTime(901, joined)).toBeNull();
        expect(toSourceTime(800, joined, 400)).toBeNull();
        expect(toSourceTime(800, joined, 600)).not.toBeNull();
        // 行の時刻は秒で切り捨てなので、参加した時刻のすぐ前は頭から
        expect(toSourceTime(299.5, joined)).toBe(0);
        expect(toSourceTime(0, { ...upload, offsetSec: 5 })).toBeNull();
        // 長さがまだ分からない（NaN）なら見ない
        expect(toSourceTime(800, joined, Number.NaN)).not.toBeNull();
    });
});
