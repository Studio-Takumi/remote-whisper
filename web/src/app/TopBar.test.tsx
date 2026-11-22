// 上のバーの高さの書き出し（--top-bar-height）と、セッションのタブの置き場（#463）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from '@/app/TopBar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

const observe = vi.fn();
let notify: () => void = () => {};
const root = document.documentElement;

beforeEach(() => {
    globalThis.ResizeObserver = class {
        constructor(callback: () => void) {
            notify = callback;
        }
        observe = observe;
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    window.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(203);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    observe.mockClear();
});

function draw(stickySlot?: (el: HTMLDivElement | null) => void) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <TooltipProvider>
                <SidebarProvider>
                    <TopBar stickySlot={stickySlot} />
                </SidebarProvider>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

describe('TopBar の高さ', () => {
    it('余白だけが変わっても測り直せるよう、border-box で見る', () => {
        draw();
        expect(observe).toHaveBeenCalledWith(expect.any(HTMLElement), { box: 'border-box' });
    });

    it('高さを --top-bar-height に書き出し、閉じたら消す', () => {
        const { unmount } = draw();
        notify();
        expect(root.style.getPropertyValue('--top-bar-height')).toBe('203px');
        unmount();
        expect(root.style.getPropertyValue('--top-bar-height')).toBe('');
    });
});

describe('TopBar の置き場', () => {
    it('置き場は上のバーの中にあり、空のうちは出さない（empty:hidden）', () => {
        let slot: HTMLDivElement | null = null;
        const { container } = draw((el) => {
            slot = el;
        });
        const bar = container.querySelector('[data-slot="top-bar"]');
        expect(slot).not.toBeNull();
        expect(bar?.contains(slot)).toBe(true);
        expect(slot!.childElementCount).toBe(0);
        expect(slot!.className).toContain('empty:hidden');
    });
});
