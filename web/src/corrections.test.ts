import { describe, expect, it } from 'vitest';

import {
    count,
    countInLines,
    describeCorrection,
    mergeLiveLines,
    replace,
    replaceLine,
    rightProblem,
    selectionProblem,
} from '@/corrections';

describe('replace と count（サーバーと同じ数え方）', () => {
    it('すでに正しい語になっているところは数えない', () => {
        expect(replace('高橋さんと高橋健さん', '高橋', '高橋健')).toBe('高橋健さんと高橋健さん');
        expect(count('高橋さんと高橋健さん', '高橋', '高橋健')).toBe(1);
    });

    it('普通の置き換え', () => {
        expect(replace('記者が貴社に', '貴社', '記者')).toBe('記者が記者に');
        expect(count('貴社と貴社', '貴社', '記者')).toBe(2);
    });

    it('同じ語・空の語では何もしない', () => {
        expect(replace('あいう', 'あ', 'あ')).toBe('あいう');
        expect(count('あいう', '', 'x')).toBe(0);
    });

    it('正しい語の途中や終わりと重なるところも触らない', () => {
        expect(replace('高橋健さんと田健さん', '田健', '高田健')).toBe('高橋健さんと高田健さん');
        expect(replace('高田健さん', '田健', '高田健')).toBe('高田健さん');
        expect(count('高田健と高田健', '健', '高田健')).toBe(0);
    });

    it('行の一覧で数える', () => {
        expect(countInLines([{ text: 'fake fake' }, { text: 'real' }, { text: 'fake' }], 'fake', 'real')).toBe(3);
    });

    it('話者の札には当てない・数えない', () => {
        expect(replaceLine('話者 1: 1 番です', '1', '一')).toBe('話者 1: 一 番です');
        expect(countInLines([{ text: '話者 1: 1 番です' }], '1', '一')).toBe(1);
    });
});

describe('録音中の取り直し', () => {
    const a = { time: '00:00:00', text: 'fake' };
    const b = { time: '00:00:03', text: 'fake 2' };
    it('取り直した方に final がまだなければ、手元の行を残す', () => {
        expect(mergeLiveLines([a, b], [{ ...a, text: 'real' }])).toEqual([{ ...a, text: 'real' }, b]);
    });
    it('取り直した方が先に final を含んでいても、行は増やさない', () => {
        expect(mergeLiveLines([a], [{ ...a, text: 'real' }, b])).toEqual([{ ...a, text: 'real' }]);
    });
});

describe('確かめ', () => {
    it('選んだ文字列', () => {
        expect(selectionProblem('  ')).not.toBeNull();
        expect(selectionProblem('a\nb')).not.toBeNull();
        expect(selectionProblem('あ'.repeat(81))).not.toBeNull();
        expect(selectionProblem('高橋')).toBeNull();
    });

    it('正しい語', () => {
        expect(rightProblem('高橋', '')).not.toBeNull();
        expect(rightProblem('高橋', '高橋')).not.toBeNull();
        expect(rightProblem('高橋', 'a/b')).not.toBeNull();
        expect(rightProblem('高橋', '高橋健')).toBeNull();
    });

    it('用語の欄の説明', () => {
        expect(describeCorrection({ from: 'a', to: 'b', line: null })).toBe('a → b');
        expect(describeCorrection({ from: 'a', to: 'b', line: { transcript: 'live', index: 2 } })).toBe(
            'a → b（リアルタイムの 3 行目だけ）',
        );
    });
});
