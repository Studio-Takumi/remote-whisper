import { describe, expect, it } from 'vitest';

import { formatDecimal, formatMonthDay } from '@/lib/format';
import { formatDisplayDateTime, formatShortDateTime } from '@/lib/time';

describe('日本語の出力は今までと同じ（#496）', () => {
    it('小数は toFixed と同じ（桁区切りなし）', () => {
        for (const v of [0, 0.04, 1.5, 4.96, 12.345, 1234.5]) {
            expect(formatDecimal(v, 1, 'ja')).toBe(v.toFixed(1));
        }
    });

    it('月と日', () => {
        expect(formatMonthDay(new Date(2026, 9, 11).getTime(), 'ja')).toBe('10/11');
    });

    it('録音日時', () => {
        expect(formatShortDateTime('2026-10-11 14:05', 'ja')).toBe('10/11 14:05');
        expect(formatShortDateTime('2026-01-02 03:04', 'ja')).toBe('1/2 03:04');
        expect(formatShortDateTime('読めない', 'ja')).toBe('読めない');
        expect(formatDisplayDateTime('2026-10-11 14:05', 'ja')).toBe('2026-10-11 14:05');
    });
});

describe('英語は Intl の自然な書き方', () => {
    it('小数は桁区切りあり', () => {
        expect(formatDecimal(1.5, 1, 'en')).toBe('1.5');
        expect(formatDecimal(1234.5, 1, 'en')).toBe('1,234.5');
    });

    it('月と日', () => {
        expect(formatMonthDay(new Date(2026, 9, 11).getTime(), 'en')).toBe('10/11');
    });

    it('録音日時', () => {
        expect(formatShortDateTime('2026-10-11 14:05', 'en')).toMatch(/^10\/11,? 2:05\s?PM$/);
        expect(formatDisplayDateTime('2026-10-11 14:05', 'en')).toMatch(/^Oct 11, 2026,? (at )?2:05\s?PM$/);
        expect(formatDisplayDateTime('読めない', 'en')).toBe('読めない');
    });
});
