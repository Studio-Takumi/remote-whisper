import { describe, expect, it } from 'vitest';

import {
    clockToSeconds,
    formatClock,
    formatDateTime,
    formatElapsed,
    formatShortDateTime,
    newId,
    sessionDuration,
} from '@/time';

describe('newId', () => {
    it('YYYYMMDD-HHMMSS の形にする', () => {
        expect(newId(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
    });
});

describe('formatElapsed', () => {
    it('1 時間未満は分と秒だけ', () => {
        expect(formatElapsed(0)).toBe('00:00');
        expect(formatElapsed(65)).toBe('01:05');
    });

    it('1 時間を超えたら時も出す', () => {
        expect(formatElapsed(3600 + 125)).toBe('1:02:05');
    });
});

describe('formatClock と clockToSeconds', () => {
    it('秒を HH:MM:SS にする（小数は切り捨て）', () => {
        expect(formatClock(3725.9)).toBe('01:02:05');
    });

    it('HH:MM:SS を秒に戻す', () => {
        expect(clockToSeconds('01:02:05')).toBe(3725);
        expect(clockToSeconds('02:05')).toBe(125);
    });

    it('読めなければ null', () => {
        expect(clockToSeconds('aa:00')).toBeNull();
        expect(clockToSeconds('01::05')).toBeNull();
    });
});

describe('formatShortDateTime', () => {
    it('月/日 時:分 にする', () => {
        expect(formatShortDateTime('2026-10-01 09:05')).toBe('10/1 09:05');
    });

    it('読めなければそのまま返す', () => {
        expect(formatShortDateTime('不明')).toBe('不明');
    });
});

describe('sessionDuration', () => {
    it('記録した長さがあればそれを使う', () => {
        expect(sessionDuration({ startedAt: '2026-10-01 09:00', endedAt: '2026-10-01 10:00', durationSec: 42 })).toBe(
            42,
        );
    });

    it('記録がなければ開始と終了の差にする', () => {
        expect(sessionDuration({ startedAt: '2026-10-01 09:00', endedAt: '2026-10-01 09:30' })).toBe(1800);
    });

    it('終了がなければ分からない', () => {
        expect(sessionDuration({ startedAt: '2026-10-01 09:00' })).toBeUndefined();
    });
});

describe('formatDateTime', () => {
    it('YYYY-MM-DD HH:MM の形にする', () => {
        expect(formatDateTime(new Date(2026, 9, 16, 8, 7))).toBe('2026-10-16 08:07');
    });
});
