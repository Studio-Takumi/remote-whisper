// 読んでいる位置の目印選び。上のバーの高さ（--top-bar-height。#463）で、読める範囲が変わる
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findAnchor, stickyTop } from '@/features/session/liveAnchor';

const root = document.documentElement;

// 区間 a・b・c の上端を、位置を決めて並べる
function sections(tops: Record<string, number>) {
    const box = document.createElement('div');
    for (const [key, top] of Object.entries(tops)) {
        const el = document.createElement('section');
        el.dataset.liveSection = key;
        el.getBoundingClientRect = () => ({ top }) as DOMRect;
        box.append(el);
    }
    return box;
}

beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
});

afterEach(() => {
    root.style.removeProperty('--top-bar-height');
});

describe('stickyTop', () => {
    it('変数がなければ 120 を目安にする', () => {
        expect(stickyTop()).toBe(120);
    });

    it('上のバーが書き出した高さを使う', () => {
        root.style.setProperty('--top-bar-height', '203px');
        expect(stickyTop()).toBe(203);
    });
});

describe('findAnchor', () => {
    // 変数なし: 読む位置は 120 + (700 - 120) / 3 ≒ 313。b（300）まで、c（400）は含まない
    it('変数がなければ、120 を元にした読む位置までの最後の区間を選ぶ', () => {
        expect(findAnchor(sections({ a: 100, b: 300, c: 400 }))).toEqual({ key: 'b', top: 300 });
    });

    // 変数 300: 読む位置は 300 + 400 / 3 ≒ 433。c（400）まで入る
    it('上のバーが高いと、読む位置が下がって選ぶ区間が変わる', () => {
        root.style.setProperty('--top-bar-height', '300px');
        expect(findAnchor(sections({ a: 100, b: 300, c: 400 }))).toEqual({ key: 'c', top: 400 });
    });

    it('一番上にいるときは選ばない', () => {
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
        expect(findAnchor(sections({ a: 100 }))).toBeNull();
    });
});
