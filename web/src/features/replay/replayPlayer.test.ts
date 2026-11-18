import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReplayPlayer } from '@/features/replay/replayPlayer';

// 偽の時計で、記録の時刻どおりに渡すか・止めたら渡さないかを確かめる
beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const items = [
    { t: 0, msg: 'a' },
    { t: 1.5, msg: 'b' },
    { t: 1.5, msg: 'c' },
    { t: 60, msg: 'd' },
    { t: 1290, msg: 'e' },
];

function player() {
    const got: [string, number][] = [];
    const onEnd = vi.fn();
    const p = new ReplayPlayer<string>((msg, t) => got.push([msg, t]), onEnd);
    return { p, got, onEnd };
}

describe('ReplayPlayer', () => {
    it('記録の時刻どおりに渡し、最後まで渡したら終わりを知らせる', () => {
        const { p, got, onEnd } = player();
        p.play(items);
        expect(got).toEqual([]);
        vi.advanceTimersByTime(0);
        expect(got.map(([m]) => m)).toEqual(['a']);
        vi.advanceTimersByTime(1499);
        expect(got.map(([m]) => m)).toEqual(['a']);
        vi.advanceTimersByTime(1);
        expect(got.map(([m]) => m)).toEqual(['a', 'b', 'c']);
        vi.advanceTimersByTime(58_500);
        expect(got.at(-1)).toEqual(['d', 60]);
        expect(p.playing).toBe(true);
        expect(onEnd).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1230_000);
        expect(got.at(-1)).toEqual(['e', 1290]);
        expect(onEnd).toHaveBeenCalledOnce();
        expect(p.playing).toBe(false);
    });

    it('途中で止めたら、それ以降は渡さない', () => {
        const { p, got, onEnd } = player();
        p.play(items);
        vi.advanceTimersByTime(2000);
        p.stop();
        vi.advanceTimersByTime(2000_000);
        expect(got.map(([m]) => m)).toEqual(['a', 'b', 'c']);
        expect(onEnd).not.toHaveBeenCalled();
        expect(p.playing).toBe(false);
    });

    it('もう一度再生したら最初から', () => {
        const { p, got } = player();
        p.play(items);
        vi.advanceTimersByTime(61_000);
        p.play(items);
        vi.advanceTimersByTime(0);
        expect(got.map(([m]) => m)).toEqual(['a', 'b', 'c', 'd', 'a']);
    });

    it('渡した先で止められたら、同じ時刻の残りも渡さない', () => {
        const got: string[] = [];
        const p: ReplayPlayer<string> = new ReplayPlayer<string>(
            (msg) => {
                got.push(msg);
                if (msg === 'b') {
                    p.stop();
                }
            },
            () => {},
        );
        p.play(items);
        vi.advanceTimersByTime(2000_000);
        expect(got).toEqual(['a', 'b']);
    });

    it('時計が遅れても、遅れた分をまとめて渡して追いつく', () => {
        const { p, got } = player();
        p.play(items);
        // タブが裏にあったなどで、タイマーが遅れて動いた
        vi.setSystemTime(Date.now() + 61_000);
        vi.advanceTimersByTime(0);
        expect(got.map(([m]) => m)).toEqual(['a', 'b', 'c', 'd']);
    });
});
