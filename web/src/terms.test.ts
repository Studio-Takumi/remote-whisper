import { describe, expect, it, vi } from 'vitest';

import { MANUAL_MAX_CHARS, addAll, isSubmitKey, parseTermInput, remainingDraft, splitTerms } from './terms';

describe('splitTerms', () => {
    it('一語はそのまま、前後の空白は取る', () => {
        expect(splitTerms('  ハルシオン ')).toEqual(['ハルシオン']);
    });

    it('複数行は行ごとに分け、空の行と重なりは捨てる', () => {
        expect(splitTerms('ハルシオン\r\n\nケルビン\nハルシオン\n')).toEqual(['ハルシオン', 'ケルビン']);
    });

    it('「、」でも分ける', () => {
        expect(splitTerms('ハルシオン、ケルビン')).toEqual(['ハルシオン', 'ケルビン']);
    });

    it('空なら何も足さない', () => {
        expect(splitTerms(' \n ')).toEqual([]);
    });
});

describe('parseTermInput', () => {
    it('足せる語と足せない語（理由つき）に分ける', () => {
        const long = 'あ'.repeat(MANUAL_MAX_CHARS + 1);
        const parsed = parseTermInput(`ハルシオン\n${long}\na/b\n${'い'.repeat(MANUAL_MAX_CHARS)}`);
        expect(parsed.valid).toEqual(['ハルシオン', 'い'.repeat(MANUAL_MAX_CHARS)]);
        expect(parsed.invalid.map((x) => x.term)).toEqual([long, 'a/b']);
        expect(parsed.invalid.every((x) => x.reason !== '')).toBe(true);
    });

    it('空の入力は何もない', () => {
        expect(parseTermInput('  ')).toEqual({ valid: [], invalid: [] });
    });
});

describe('isSubmitKey', () => {
    it('Enter で足す', () => {
        expect(isSubmitKey({ key: 'Enter', isComposing: false })).toBe(true);
    });

    it('変換中の Enter では足さない', () => {
        expect(isSubmitKey({ key: 'Enter', isComposing: true })).toBe(false);
    });

    it('Enter 以外では足さない', () => {
        expect(isSubmitKey({ key: 'a', isComposing: false })).toBe(false);
    });
});

describe('addAll', () => {
    it('複数行の貼り付けは行ごとに足し、足せなかった語だけが残る', async () => {
        const add = vi.fn(async (term: string) => term !== 'ケルビン');
        const { valid } = parseTermInput('ハルシオン\nケルビン\nフォトンリンク');
        const { added, failed } = await addAll(valid, add);
        expect(add.mock.calls.map((c) => c[0])).toEqual(['ハルシオン', 'ケルビン', 'フォトンリンク']);
        expect(added).toEqual(['ハルシオン', 'フォトンリンク']);
        expect(remainingDraft(failed)).toBe('ケルビン');
    });
});
