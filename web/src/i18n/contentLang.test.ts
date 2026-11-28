import { describe, expect, it } from 'vitest';

import { contentLang } from './contentLang';

describe('contentLang', () => {
    it('仮名か漢字があれば ja', () => {
        expect(contentLang('今日はリリース計画について')).toBe('ja');
        expect(contentLang('カタカナ')).toBe('ja');
        expect(contentLang('線形代数 行列式')).toBe('ja');
        expect(contentLang('ﾊﾝｶｸ')).toBe('ja');
        expect(contentLang('Release plan', '週次の進捗')).toBe('ja');
    });

    it('ほかは付けない（親の lang のまま）', () => {
        expect(contentLang('Weekly sync')).toBeUndefined();
        expect(contentLang('')).toBeUndefined();
        expect(contentLang(undefined, null)).toBeUndefined();
        expect(contentLang()).toBeUndefined();
        // 全角の記号だけでは決めない
        expect(contentLang('（）・')).toBeUndefined();
    });
});
