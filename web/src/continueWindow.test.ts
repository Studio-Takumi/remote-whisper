import { describe, expect, it } from 'vitest';

import { continueLeftSec, describeLeft } from '@/continueWindow';

const ended = '2026-10-20T10:00:00+09:00';
const at = (sec: number) => Date.parse(ended) + sec * 1000;

describe('continueLeftSec', () => {
    it('普通に終えてから時間の間は、残りの秒数', () => {
        expect(continueLeftSec({ status: 'done', endedAt: ended }, 10, at(60))).toBe(540);
        expect(continueLeftSec({ status: 'interrupted', endedAt: ended }, 10, at(0))).toBe(600);
    });

    it('時間を過ぎた・録音中・音声ファイルから作った・0 分の設定なら続けられない', () => {
        expect(continueLeftSec({ status: 'done', endedAt: ended }, 10, at(601))).toBeNull();
        expect(continueLeftSec({ status: 'recording', endedAt: ended }, 10, at(1))).toBeNull();
        expect(continueLeftSec({ status: 'done', endedAt: ended, uploaded: true }, 10, at(1))).toBeNull();
        expect(continueLeftSec({ status: 'done', endedAt: ended }, 0, at(0))).toBeNull();
        expect(continueLeftSec({ status: 'done' }, 10, at(1))).toBeNull();
    });
});

describe('describeLeft', () => {
    it('分で出す', () => {
        expect(describeLeft(540)).toBe('あと 9 分');
        expect(describeLeft(59)).toBe('あと 1 分未満');
    });
});
