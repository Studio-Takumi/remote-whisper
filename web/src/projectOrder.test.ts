import { describe, expect, it } from 'vitest';

import { projectIdOf, reorderedIds, sortByIds, sortableId } from '@/projectOrder';

describe('sortableId / projectIdOf', () => {
    it('接頭辞を付けて、取り出せる', () => {
        expect(sortableId('a')).toBe('project:a');
        expect(projectIdOf(sortableId('a'))).toBe('a');
    });

    it('並び替え用の ID でなければ null（セッションを離す先の ID など）', () => {
        expect(projectIdOf('a')).toBeNull();
        expect(projectIdOf('a:s1')).toBeNull();
        expect(projectIdOf(null)).toBeNull();
        expect(projectIdOf(3)).toBeNull();
    });
});

describe('reorderedIds', () => {
    const ids = ['a', 'b', 'c', 'd'];

    it('下へ動かすと、離した位置に入る', () => {
        expect(reorderedIds(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    });

    it('上へ動かすと、離した位置に入る', () => {
        expect(reorderedIds(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    });

    it('同じ位置・外で離した・知らない ID のときは動かさない', () => {
        expect(reorderedIds(ids, 'b', 'b')).toBeNull();
        expect(reorderedIds(ids, 'b', null)).toBeNull();
        expect(reorderedIds(ids, 'b', 'x')).toBeNull();
        expect(reorderedIds(ids, 'x', 'b')).toBeNull();
    });

    it('元の配列は変えない', () => {
        reorderedIds(ids, 'a', 'd');
        expect(ids).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('sortByIds', () => {
    const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('ids の順に並べる。消えた ID は無視する', () => {
        expect(sortByIds(projects, ['c', 'x', 'a', 'b']).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    });

    it('ids にないものは今の順のまま後ろに置く', () => {
        expect(sortByIds(projects, ['c']).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    });
});
