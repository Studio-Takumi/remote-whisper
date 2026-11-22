// App が上のバーの置き場を SessionView に渡し、セッションのタブが上のバーの中に出ること（#463）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectInfo } from '@/api/projects';
import { initialServerStatus } from '@/api/status';
import type { Session } from '@/api/types';
import App from '@/app/App';
import { useAppStore } from '@/app/store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { defaultSettings } from '@/features/settings/settings';

vi.mock('@/app/router', () => ({ startRouter: () => () => {} }));
// 今回見ない部分（PWA の更新・サイドバー・ダイアログ・開発パネル）は空にする
vi.mock('@/app/PwaUpdater', () => ({ PwaUpdater: () => null }));
vi.mock('@/app/AppSidebar', () => ({ AppSidebar: () => null }));
vi.mock('@/app/DevPanel', () => ({ DevPanel: () => null }));
vi.mock('@/features/settings/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('@/features/setup/SetupDialog', () => ({ SetupDialog: () => null }));
vi.mock('@/features/projects/NewProjectDialog', () => ({ NewProjectDialog: () => null }));

const PROJECT: ProjectInfo = { id: 'p1', name: '講義', path: '/data/lecture' };
const initial = useAppStore.getState();

const SESSION: Session = {
    id: '2026-11-17_10-00-00',
    title: '第 3 回の講義',
    startedAt: '2026-11-17 10:00',
    status: 'done',
    loaded: true,
    transcript: [{ time: '00:00:01', text: 'はじめます' }],
    summaries: [],
};

beforeEach(() => {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    window.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const noop = vi.fn();
    useAppStore.setState({
        ...initial,
        loadOptions: noop,
        loadSettings: noop,
        loadProjects: noop,
        watchMicrophone: noop,
        connectServer: noop,
        settings: defaultSettings,
        server: initialServerStatus,
    });
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.clearAllMocks();
});

function draw(sessionId: string | null, projectId: string | null = PROJECT.id) {
    const client = new QueryClient();
    client.setQueryData(['projects'], [PROJECT]);
    useAppStore.setState({
        selection: { projectId, sessionId },
        localSessions: [{ projectId: PROJECT.id, session: SESSION }],
    });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <App />
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

describe('App の上のバー', () => {
    it('セッションを開くと、タブが上のバーの中に出る', async () => {
        const { container } = draw(SESSION.id);
        await act(async () => {});
        const bar = container.querySelector('[data-slot="top-bar"]');
        expect(bar?.contains(screen.getByRole('tab', { name: '要約' }))).toBe(true);
    });

    it('セッションを開いていない画面では、置き場が空で高さに効かない', async () => {
        const { container } = draw(null, null);
        await act(async () => {});
        const bar = container.querySelector('[data-slot="top-bar"]');
        const slot = bar?.lastElementChild as HTMLElement;
        expect(slot.childElementCount).toBe(0);
        expect(slot.className).toContain('empty:hidden');
        expect(screen.queryByRole('tab', { name: '要約' })).toBeNull();
    });
});
