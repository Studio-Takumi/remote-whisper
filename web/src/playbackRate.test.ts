import { describe, expect, it } from 'vitest';

import { formatRate, loadRate, normalizeRate, parseRate, saveRate } from '@/playbackRate';

describe('normalizeRate', () => {
    it('範囲に収める', () => {
        expect(normalizeRate(0.1)).toBe(0.5);
        expect(normalizeRate(10)).toBe(3);
        expect(normalizeRate(-1)).toBe(0.5);
    });

    it('0.05 刻みに丸める', () => {
        expect(normalizeRate(1.23)).toBe(1.25);
        expect(normalizeRate(1.274)).toBe(1.25);
        expect(normalizeRate(1.3)).toBe(1.3);
        expect(normalizeRate(1.1)).toBe(1.1);
    });

    it('数でなければ等速', () => {
        expect(normalizeRate(Number.NaN)).toBe(1);
        expect(normalizeRate(Number.POSITIVE_INFINITY)).toBe(1);
    });
});

describe('parseRate', () => {
    it('文字を数にして丸める。空や数でない文字は null', () => {
        expect(parseRate(' 1.5 ')).toBe(1.5);
        expect(parseRate('4')).toBe(3);
        expect(parseRate('')).toBeNull();
        expect(parseRate('abc')).toBeNull();
    });
});

describe('formatRate', () => {
    it('× を付ける', () => {
        expect(formatRate(1.25)).toBe('1.25×');
        expect(formatRate(1)).toBe('1×');
    });
});

describe('loadRate / saveRate', () => {
    it('保存した速度を読む。なければ・壊れていれば等速', () => {
        const data = new Map<string, string>();
        const storage = {
            getItem: (k: string) => data.get(k) ?? null,
            setItem: (k: string, v: string) => void data.set(k, v),
        };
        expect(loadRate(storage)).toBe(1);
        saveRate(1.75, storage);
        expect(loadRate(storage)).toBe(1.75);
        saveRate(9, storage);
        expect(loadRate(storage)).toBe(3);
        data.set('rw.playbackRate', 'x');
        expect(loadRate(storage)).toBe(1);
    });

    it('localStorage が使えなくても落ちない', () => {
        const broken = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        expect(loadRate(broken)).toBe(1);
        expect(() => saveRate(2, broken)).not.toThrow();
        expect(loadRate(null)).toBe(1);
    });
});
