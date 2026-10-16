import { afterEach, describe, expect, it, vi } from 'vitest';

import { isScrolledToBottom } from '@/scroll';

// jsdom はレイアウトをしないので、スクロールの位置と大きさを決めておく
function layout(scrollTop: number, clientHeight: number, scrollHeight: number) {
    const el = document.scrollingElement ?? document.documentElement;
    vi.spyOn(el, 'scrollTop', 'get').mockReturnValue(scrollTop);
    vi.spyOn(el, 'clientHeight', 'get').mockReturnValue(clientHeight);
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
}

describe('isScrolledToBottom', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('一番下にいれば true', () => {
        layout(1200, 800, 2000);
        expect(isScrolledToBottom()).toBe(true);
    });

    it('一番下から少し上（マイクのボタンの分）までは一番下とみなす', () => {
        layout(1050, 800, 2000);
        expect(isScrolledToBottom()).toBe(true);
    });

    it('それより上なら false', () => {
        layout(1000, 800, 2000);
        expect(isScrolledToBottom()).toBe(false);
    });
});
