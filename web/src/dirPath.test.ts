import { describe, expect, it } from 'vitest';

import { isSameOrAncestor } from '@/dirPath';

describe('isSameOrAncestor', () => {
    it('同じパスと祖先は true', () => {
        expect(isSameOrAncestor('/home/a', '/home/a')).toBe(true);
        expect(isSameOrAncestor('/home', '/home/a/b')).toBe(true);
        expect(isSameOrAncestor('D:\\work', 'D:\\work\\meetings\\weekly')).toBe(true);
    });

    it('名前が前方一致するだけの兄弟は false', () => {
        expect(isSameOrAncestor('/home/a', '/home/ab')).toBe(false);
        expect(isSameOrAncestor('D:\\work\\meet', 'D:\\work\\meetings')).toBe(false);
    });

    it('子孫・別の場所は false', () => {
        expect(isSameOrAncestor('/home/a/b', '/home/a')).toBe(false);
        expect(isSameOrAncestor('/x', '/home/a')).toBe(false);
    });

    it('Windows のパスは大文字・小文字を区別しない', () => {
        expect(isSameOrAncestor('d:\\Work', 'D:\\work\\Meetings')).toBe(true);
        expect(isSameOrAncestor('/Home', '/home/a')).toBe(false);
    });
});
