// 上のバーの GPU の状態と、押すと開くジョブの一覧（#381 で部品を分ける前に確かめる）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectInfo } from '@/api/data';
import type { GpuJobs } from '@/api/protocol';
import { initialServerStatus } from '@/api/status';
import type { Session } from '@/api/types';
import { GpuIndicator } from '@/app/GpuIndicator';
import { useAppStore } from '@/app/store';

const PROJECT: ProjectInfo = { id: 'p1', name: '講義', path: '/data/lecture' };
const initial = useAppStore.getState();
const selectSession = vi.fn();

const SESSION: Session = {
    id: 's1',
    uuid: 'u-1',
    title: '第 3 回',
    startedAt: '2026-11-17T10:00:00+09:00',
    status: 'done',
    transcript: [],
    summaries: [],
};

beforeEach(() => {
    useAppStore.setState({ ...initial, selectSession });
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.clearAllMocks();
});

function draw(jobs: GpuJobs, gpu: { util: number; memUsedMb: number; memTotalMb: number } | null = null) {
    const client = new QueryClient();
    client.setQueryData(['projects'], [PROJECT]);
    useAppStore.setState({
        server: { ...initialServerStatus, jobs, gpu, jobsAt: Date.now() },
        localSessions: [{ projectId: PROJECT.id, session: SESSION }],
    });
    render(
        <QueryClientProvider client={client}>
            <GpuIndicator />
        </QueryClientProvider>,
    );
}

function open() {
    act(() => {
        fireEvent.click(screen.getByRole('button'));
    });
}

describe('GpuIndicator', () => {
    it('ジョブがなければ GPU とだけ出し、一覧は「なし」', () => {
        draw({ running: null, waiting: [] });
        const button = screen.getByRole('button');
        expect(button.getAttribute('aria-label')).toBe('GPU の状態とジョブの一覧');
        expect(button.textContent).toContain('GPU');
        open();
        expect(screen.getByText('使用率は取れません（NVIDIA の GPU がないなど）')).toBeTruthy();
        expect(screen.getAllByText('なし')).toHaveLength(2);
    });

    it('使用率と待ちの数をボタンに出す', () => {
        draw(
            {
                running: null,
                waiting: [
                    { kind: 'liveSummary', session: null, count: 2, waitingSec: 3 },
                    { kind: 'terms', session: null, count: 1, waitingSec: 1 },
                ],
            },
            { util: 42, memUsedMb: 2048, memTotalMb: 6144 },
        );
        const button = screen.getByRole('button');
        expect(button.getAttribute('aria-label')).toBe('GPU の状態とジョブの一覧（使用率 42%、待ち 3 件）');
        expect(button.textContent).toContain('42%');
        expect(button.textContent).toContain('待ち 3');
        open();
        expect(screen.getByText('使用率 42% ・ VRAM 2.0 / 6.0 GB')).toBeTruthy();
        expect(screen.getByText('1. リアルタイム要約 ×2')).toBeTruthy();
        expect(screen.getByText('2. 文字起こしからの用語抽出')).toBeTruthy();
    });

    it('実行中のジョブは進み具合を出し、セッションへのリンクにする', () => {
        draw({
            running: {
                kind: 'finalTranscript',
                session: 's1',
                runningSec: 65,
                progress: { step: 'transcribe', percent: 40 },
            },
            waiting: [{ kind: 'finalSummary', session: 'gone', count: 1, waitingSec: 5 }],
        } as GpuJobs);
        open();
        const link = screen.getByRole('link');
        expect(link.getAttribute('href')).toBe('/s/u-1');
        expect(link.getAttribute('aria-label')).toMatch(/^文字起こしの浄書のセッション「第 3 回」を開く（/);
        expect(screen.getByText('gone（見つかりません）')).toBeTruthy();
        fireEvent.click(link, { button: 0 });
        expect(selectSession).toHaveBeenCalledWith('p1', 's1');
    });
});
