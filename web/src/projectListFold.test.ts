// サイドバーのプロジェクトの開閉を覚える（#318）を、ProjectList を実際に描いて確かめる
import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectList } from '@/components/ProjectList';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Project } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (id: string): Project => ({
    id,
    name: id,
    path: `/p/${id}`,
    sessions: [
        {
            id: `${id}-s1`,
            title: `${id} の録音`,
            startedAt: '2026-11-11T09:00:00+09:00',
            status: 'done',
        } as Project['sessions'][number],
    ],
});

let container: HTMLDivElement;
let root: Root;

function draw(
    projects: Project[],
    active: { project: string | null; session: string | null } = { project: null, session: null },
) {
    act(() => {
        root.render(
            createElement(
                TooltipProvider,
                null,
                createElement(
                    SidebarProvider,
                    null,
                    createElement(ProjectList, {
                        projects,
                        activeProject: active.project,
                        activeSession: active.session,
                        showMeta: false,
                        onSelectSession: () => {},
                        onNewSession: () => {},
                        moveBlocker: () => null,
                        onMove: () => {},
                        onReorder: () => {},
                    }),
                ),
            ),
        );
    });
}

function expanded(): Record<string, boolean> {
    return Object.fromEntries(
        [...container.querySelectorAll('[data-slot=accordion-trigger]')].map((t) => [
            t.textContent?.trim() ?? '',
            t.getAttribute('aria-expanded') === 'true',
        ]),
    );
}

function toggle(name: string) {
    const trigger = [...container.querySelectorAll<HTMLElement>('[data-slot=accordion-trigger]')].find((t) =>
        t.textContent?.includes(name),
    );
    act(() => trigger?.click());
}

function remount() {
    act(() => root.unmount());
    root = createRoot(container);
}

beforeEach(() => {
    localStorage.clear();
    window.matchMedia ??= ((query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('ProjectList の開閉', () => {
    it('はじめは全部開いている', () => {
        draw([project('A'), project('B')]);
        expect(expanded()).toEqual({ A: true, B: true });
    });

    it('閉じたものは開き直しても閉じたまま。開いたら開いたまま', () => {
        draw([project('A'), project('B')]);
        toggle('B');
        expect(expanded()).toEqual({ A: true, B: false });
        remount();
        draw([project('A'), project('B')]);
        expect(expanded()).toEqual({ A: true, B: false });
        toggle('B');
        remount();
        draw([project('A'), project('B')]);
        expect(expanded()).toEqual({ A: true, B: true });
    });

    it('あとから増えたプロジェクトは開いて出る', () => {
        draw([project('A')]);
        toggle('A');
        draw([project('A'), project('C')]);
        expect(expanded()).toEqual({ A: false, C: true });
    });

    it('閉じているプロジェクトのセッションを開くと、そのプロジェクトを開く', () => {
        draw([project('A'), project('B')]);
        toggle('B');
        draw([project('A'), project('B')], { project: 'B', session: 'B-s1' });
        expect(expanded()).toEqual({ A: true, B: true });
        // 開いたまま見出しを閉じるのは止めない
        toggle('B');
        expect(expanded()).toEqual({ A: true, B: false });
    });
});
