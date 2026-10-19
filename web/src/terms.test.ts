import { describe, expect, it } from 'vitest';

import { splitTerms } from './terms';

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
