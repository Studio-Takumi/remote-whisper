// マイクボタンが状態ごとに何を出し、押すと何をするか（#381 で中の計算を分ける前に確かめる）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectInfo } from '@/api/projects';
import { initialServerStatus } from '@/api/status';
import type { Session } from '@/api/types';
import { useAppStore } from '@/app/store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MicButton } from '@/features/recording/MicButton';
import { defaultSettings } from '@/features/settings/settings';

const PROJECT: ProjectInfo = { id: 'p1', name: '講義', path: '/data/lecture' };
const initial = useAppStore.getState();

const actions = {
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => {}),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    showRecordingSession: vi.fn(),
    continueRecording: vi.fn(async () => {}),
    joinSession: vi.fn(async () => {}),
    leaveSession: vi.fn(),
};

beforeEach(() => {
    useAppStore.setState({ ...initial, ...actions, settings: defaultSettings, server: initialServerStatus });
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.clearAllMocks();
});

function session(patch: Partial<Session> = {}): Session {
    return {
        id: 's1',
        title: '第 3 回',
        startedAt: '2026-11-17T10:00:00+09:00',
        endedAt: '2020-01-01T10:00:00+09:00',
        status: 'done',
        loaded: true,
        transcript: [],
        summaries: [],
        ...patch,
    };
}

function draw({ projectId = 'p1' as string | null, current }: { projectId?: string | null; current?: Session } = {}) {
    const client = new QueryClient();
    client.setQueryData(['projects'], [PROJECT]);
    useAppStore.setState({
        selection: { projectId, sessionId: current?.id ?? null },
        localSessions: current ? [{ projectId: PROJECT.id, session: current }] : [],
    });
    render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <MicButton />
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

function main() {
    return screen.getAllByRole('button')[0];
}

describe('MicButton', () => {
    it('プロジェクトを選んでいなければ選ぶように促す', () => {
        draw({ projectId: null });
        expect(main().getAttribute('aria-label')).toBe('録音するプロジェクトをメニューから選んでください');
        expect(screen.getByText('プロジェクトを選んでください')).toBeTruthy();
    });

    it('新しいセッションの画面では押すと録音を始める', () => {
        draw();
        expect(main().getAttribute('aria-label')).toBe('クリックして録音開始');
        expect(main().getAttribute('aria-keyshortcuts')).toBeTruthy();
        fireEvent.click(main());
        expect(actions.startRecording).toHaveBeenCalled();
    });

    it('マイクが許可されていなければそう出す', () => {
        useAppStore.setState({ server: { ...initialServerStatus, microphone: 'denied' } });
        draw();
        expect(main().getAttribute('aria-label')).toBe(
            'マイクが許可されていません。ブラウザの設定でマイクを許可してください',
        );
    });

    it('既存のセッションを開いていれば新しいセッションを作る', () => {
        draw({ current: session() });
        expect(main().getAttribute('aria-label')).toBe('クリックして「講義」に新しいセッションを作成');
        expect(screen.getByText('押すと新しいセッション')).toBeTruthy();
    });

    it('終えたばかりのセッションは続きから録音できる', () => {
        const s = session({ endedAt: new Date(Date.now() - 60_000).toISOString(), durationSec: 60 });
        draw({ current: s });
        expect(main().getAttribute('aria-label')).toMatch(/^クリックして続きから録音（録音を終えてから 10 分の間は/);
        fireEvent.click(main());
        expect(actions.continueRecording).toHaveBeenCalledWith('s1');
    });

    it('録音中は一時停止と終了のボタンと経過時間を出す', () => {
        useAppStore.setState({ recordingState: 'recording', recordingSessionId: 's1', elapsed: 65 });
        draw({ current: session({ status: 'recording' }) });
        expect(main().getAttribute('aria-label')).toBe('クリックして一時停止');
        expect(screen.getByText('01:05')).toBeTruthy();
        fireEvent.click(main());
        expect(actions.pauseRecording).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'クリックして録音終了' }));
        expect(actions.stopRecording).toHaveBeenCalled();
    });

    it('一時停止中は押すと再開する', () => {
        useAppStore.setState({ recordingState: 'paused', recordingSessionId: 's1' });
        draw({ current: session({ status: 'recording' }) });
        expect(main().getAttribute('aria-label')).toBe('クリックして録音再開');
        fireEvent.click(main());
        expect(actions.resumeRecording).toHaveBeenCalled();
    });

    it('録音中にほかの画面を開いていれば、録音中のセッションに戻るボタンにする', () => {
        useAppStore.setState({ recordingState: 'recording', recordingSessionId: 'rec' });
        draw();
        expect(main().getAttribute('aria-label')).toBe('「新しいセッション」で録音中です。クリックで戻ります');
        expect(screen.queryByRole('button', { name: 'クリックして録音終了' })).toBeNull();
        fireEvent.click(main());
        expect(actions.showRecordingSession).toHaveBeenCalled();
    });

    it('ほかの端末で録音中のセッションは、参加できれば参加のボタンにする', () => {
        const s = session({ status: 'recording' });
        useAppStore.setState({
            watching: { sessionId: 's1', state: 'recording', join: { available: true } },
        } as never);
        draw({ current: s });
        expect(main().getAttribute('aria-label')).toMatch(/クリックしてこの端末のマイクで参加$/);
        fireEvent.click(main());
        expect(actions.joinSession).toHaveBeenCalledWith('s1');
    });

    it('参加している間は、押すと参加をやめる', () => {
        useAppStore.setState({
            watching: { sessionId: 's1', state: 'recording', join: { available: true } },
            joined: { sessionId: 's1', state: 'joined', source: 2 },
        } as never);
        draw({ current: session({ status: 'recording' }) });
        expect(main().getAttribute('aria-label')).toBe('音源 2 として参加中。クリックして参加をやめる');
        expect(screen.getByRole('status').textContent).toBe('音源 2 として参加中');
        act(() => {
            fireEvent.click(main());
        });
        expect(actions.leaveSession).toHaveBeenCalled();
    });

    it('参加できなければ理由を出し、押せない', () => {
        useAppStore.setState({
            watching: { sessionId: 's1', state: 'recording', join: { available: false, reason: 'full' } },
        } as never);
        draw({ current: session({ status: 'recording' }) });
        expect(main().getAttribute('aria-disabled')).toBe('true');
    });
});
