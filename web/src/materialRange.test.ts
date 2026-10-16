import { describe, expect, it } from 'vitest';

import { describeMaterialRange } from '@/materialRange';

describe('describeMaterialRange', () => {
    it('資料ごとに範囲をまとめる', () => {
        expect(
            describeMaterialRange([
                { file: 'slides.pdf', path: 'D:\\a\\slides.pdf', from: 12, to: 30 },
                { file: 'slides.pdf', path: 'D:\\a\\slides.pdf', from: 40, to: 40 },
                { file: 'notes.md', path: 'D:\\a\\notes.md', from: 2, to: 3 },
            ]),
        ).toBe(
            '参考資料は、今回扱った範囲（slides.pdf の 12〜30・40 ページ、notes.md の 2〜3 番目の区切り）で作り直しました',
        );
    });
});
