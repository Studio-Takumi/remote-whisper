import { describe, expect, it } from 'vitest';

import { closedIds, closedKey, loadClosed, openIds, saveClosed } from '@/projectFold';

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    };
}

const broken = {
    getItem: () => {
        throw new Error('blocked');
    },
    setItem: () => {
        throw new Error('blocked');
    },
    removeItem: () => {
        throw new Error('blocked');
    },
};

describe('closedKey', () => {
    it('クラウド版ではホストごとに分ける', () => {
        expect(closedKey(null)).toBe('rw.closedProjects');
        expect(closedKey('h1')).toBe('rw.closedProjects.h1');
    });
});

describe('loadClosed / saveClosed', () => {
    it('保存したものを読み戻す。ホストが違えば別', () => {
        const s = memoryStorage();
        saveClosed('h1', ['a', 'b'], s);
        expect(loadClosed('h1', s)).toEqual(['a', 'b']);
        expect(loadClosed('h2', s)).toEqual([]);
        expect(loadClosed(null, s)).toEqual([]);
    });

    it('全部開いたら消す', () => {
        const s = memoryStorage();
        saveClosed(null, ['a'], s);
        saveClosed(null, [], s);
        expect(s.data.size).toBe(0);
    });

    it('壊れた値・文字列でない要素は読み捨てる', () => {
        expect(loadClosed(null, memoryStorage({ 'rw.closedProjects': '{' }))).toEqual([]);
        expect(loadClosed(null, memoryStorage({ 'rw.closedProjects': '"a"' }))).toEqual([]);
        expect(loadClosed(null, memoryStorage({ 'rw.closedProjects': '["a",1,null]' }))).toEqual(['a']);
    });

    it('localStorage が使えなくても落ちない', () => {
        expect(loadClosed(null, broken)).toEqual([]);
        expect(() => saveClosed(null, ['a'], broken)).not.toThrow();
        expect(loadClosed(null, null)).toEqual([]);
    });
});

describe('openIds / closedIds', () => {
    it('閉じていないものが開いている。新しいプロジェクトは開いて出る', () => {
        expect(openIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
        expect(openIds(['a', 'b', 'new'], ['b'])).toEqual(['a', 'new']);
    });

    it('開いているものから閉じているものを出し直す。今ないプロジェクトの ID は落ちる', () => {
        expect(closedIds(['a', 'b', 'c'], ['a'])).toEqual(['b', 'c']);
        expect(closedIds(['a', 'b'], openIds(['a', 'b'], ['b', 'deleted']))).toEqual(['b']);
    });
});
