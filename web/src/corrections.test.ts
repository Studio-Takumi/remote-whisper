import { describe, expect, it } from 'vitest';

import { count, countInLines, describeCorrection, replace, rightProblem, selectionProblem } from '@/corrections';

describe('replace と count（サーバーと同じ数え方）', () => {
    it('すでに正しい語になっているところは数えない', () => {
        expect(replace('岩田さんと岩田匠さん', '岩田', '岩田匠')).toBe('岩田匠さんと岩田匠さん');
        expect(count('岩田さんと岩田匠さん', '岩田', '岩田匠')).toBe(1);
    });

    it('普通の置き換え', () => {
        expect(replace('記者が貴社に', '貴社', '記者')).toBe('記者が記者に');
        expect(count('貴社と貴社', '貴社', '記者')).toBe(2);
    });

    it('同じ語・空の語では何もしない', () => {
        expect(replace('あいう', 'あ', 'あ')).toBe('あいう');
        expect(count('あいう', '', 'x')).toBe(0);
    });

    it('行の一覧で数える', () => {
        expect(countInLines([{ text: 'fake fake' }, { text: 'real' }, { text: 'fake' }], 'fake', 'real')).toBe(3);
    });
});

describe('確かめ', () => {
    it('選んだ文字列', () => {
        expect(selectionProblem('  ')).not.toBeNull();
        expect(selectionProblem('a\nb')).not.toBeNull();
        expect(selectionProblem('あ'.repeat(81))).not.toBeNull();
        expect(selectionProblem('岩田')).toBeNull();
    });

    it('正しい語', () => {
        expect(rightProblem('岩田', '')).not.toBeNull();
        expect(rightProblem('岩田', '岩田')).not.toBeNull();
        expect(rightProblem('岩田', 'a/b')).not.toBeNull();
        expect(rightProblem('岩田', '岩田匠')).toBeNull();
    });

    it('用語の欄の説明', () => {
        expect(describeCorrection({ from: 'a', to: 'b', line: null })).toBe('a → b');
        expect(describeCorrection({ from: 'a', to: 'b', line: { transcript: 'live', index: 2 } })).toBe(
            'a → b（リアルタイムの 3 行目だけ）',
        );
    });
});
