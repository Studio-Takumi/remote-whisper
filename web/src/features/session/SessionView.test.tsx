// メイン画面の中身（空の表示・新しいセッション・文字起こし・浄書・要約）の出し分けと、ボタンを押したときの呼び出し。
// 部品を分けても同じに出ることを確かめる（#381）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectInfo } from '@/api/projects';
import { initialServerStatus } from '@/api/status';
import type { Session, Summary } from '@/api/types';
import { useAppStore } from '@/app/store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionView } from '@/features/session/SessionView';
import { defaultSettings } from '@/features/settings/settings';

const PROJECT: ProjectInfo = { id: 'p1', name: '講義', path: '/data/lecture' };

const initial = useAppStore.getState();

const actions = {
    regenerateSummary: vi.fn(async () => {}),
    regenerateFinalTranscript: vi.fn(async () => {}),
    showFinalTranscript: vi.fn(async () => {}),
    continueRecording: vi.fn(async () => {}),
};

beforeEach(() => {
    // jsdom にないもの（タブのスクロール位置・文字起こしの高さの見張り）
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    useAppStore.setState({
        ...initial,
        ...actions,
        settings: defaultSettings,
        server: initialServerStatus,
        options: { ...initial.options, whisper: { ...initial.options.whisper, finalTranscript: true } },
    });
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.clearAllMocks();
});

function session(patch: Partial<Session> = {}): Session {
    return {
        id: '2026-11-17_10-00-00',
        title: '第 3 回の講義',
        startedAt: '2026-11-17 10:00',
        status: 'done',
        loaded: true,
        transcript: [
            { time: '00:00:01', text: 'はじめます' },
            { time: '00:00:05', text: '今日は二分探索です' },
        ],
        summaries: [],
        ...patch,
    };
}

function summary(id: string, model = 'gemma4:e4b', text = `要約 ${id}`): Summary {
    return { generationId: id, model, generatedAt: `2026-11-17 1${id}:00`, text };
}

function draw({
    projects = [PROJECT],
    projectId = PROJECT.id as string | null,
    current,
    stickySlot,
}: { projects?: ProjectInfo[]; projectId?: string | null; current?: Session; stickySlot?: HTMLElement | null } = {}) {
    const client = new QueryClient();
    client.setQueryData(['projects'], projects);
    useAppStore.setState({
        selection: { projectId, sessionId: current?.id ?? null },
        localSessions: current ? [{ projectId: PROJECT.id, session: current }] : [],
    });
    render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <SessionView stickySlot={stickySlot} />
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

function openSummary() {
    act(() => {
        fireEvent.mouseDown(screen.getByRole('tab', { name: '要約' }), { button: 0 });
    });
}

describe('SessionView の空の表示', () => {
    it('プロジェクトがなければ作るように促す', () => {
        draw({ projects: [], projectId: null });
        expect(screen.getByText('まずはプロジェクトを作りましょう')).toBeTruthy();
    });

    it('何も選んでいなければ開くか録音するように促す', () => {
        draw({ projectId: null });
        expect(screen.getByText('セッションを開くか、新しく録音しましょう')).toBeTruthy();
    });

    it('URL のものが見つからなければそう出す', () => {
        useAppStore.setState({ notFound: true });
        draw({ projectId: null });
        expect(screen.getByText('見つかりません')).toBeTruthy();
    });
});

describe('SessionView のタブの置き場（#463）', () => {
    it('置き場があれば、タブはそこ（上のバーの中）に出る', () => {
        const slot = document.createElement('div');
        document.body.append(slot);
        draw({ current: session(), stickySlot: slot });
        expect(slot.contains(screen.getByRole('tab', { name: '要約' }))).toBe(true);
        slot.remove();
    });

    it('高さの足りない画面では、再生バーなどを置き場に入れず本文の頭に出す', () => {
        window.matchMedia = ((query: string) => ({
            matches: true,
            media: query,
            addEventListener() {},
            removeEventListener() {},
        })) as unknown as typeof window.matchMedia;
        const slot = document.createElement('div');
        document.body.append(slot);
        draw({ current: session({ files: { recording: true } as Session['files'] }), stickySlot: slot });
        const player = screen.getByLabelText('録音を再生');
        expect(slot.contains(player)).toBe(false);
        expect(slot.contains(screen.getByRole('tab', { name: '要約' }))).toBe(true);
        slot.remove();
        // @ts-expect-error jsdom には元からない
        delete window.matchMedia;
    });

    it('置き場がまだなければ、タブは出さない', () => {
        draw({ current: session(), stickySlot: null });
        expect(screen.queryByRole('tab', { name: '要約' })).toBeNull();
    });
});

describe('SessionView の新しいセッション', () => {
    it('録音先と、マイクボタン・音声ファイルの案内を出す', () => {
        draw();
        expect(screen.getByRole('heading', { name: '新しいセッション' })).toBeTruthy();
        expect(screen.getByText('講義（/data/lecture）に録音します')).toBeTruthy();
        expect(screen.getByText('マイクボタンを押すと録音が始まります')).toBeTruthy();
        openSummary();
        expect(screen.getByText('録音が始まると、5 分おきにリアルタイム要約がここに出ます')).toBeTruthy();
    });

    it('ほかのセッションで録音中ならそう出す', () => {
        useAppStore.setState({ recordingState: 'recording', recordingSessionId: 'other' });
        draw();
        expect(screen.getByText('ほかのセッションで録音中です。終えると、ここから録音できます')).toBeTruthy();
    });
});

describe('SessionView の文字起こし', () => {
    it('タイトルと行を出す', () => {
        draw({ current: session({ provisionalTitle: true, uploaded: true }) });
        expect(screen.getByRole('heading', { name: /第 3 回の講義/ }).textContent).toContain('（仮のタイトル）');
        expect(screen.getByText('今日は二分探索です')).toBeTruthy();
        expect(screen.getByText('音声ファイルから作成')).toBeTruthy();
    });

    it('途中で終わったセッションは続きから録音できる', () => {
        const s = session({ status: 'interrupted' });
        draw({ current: s });
        expect(screen.getByText(/・途中で中断/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /続きから録音/ }));
        expect(actions.continueRecording).toHaveBeenCalledWith(s.id);
    });

    it('期限切れで消えたものはそう出す', () => {
        draw({
            current: session({
                transcript: [],
                files: { recording: false, transcript: false, summaries: 0, liveSummary: false } as Session['files'],
            }),
        });
        expect(screen.getByText('文字起こしは期限切れのため消えています')).toBeTruthy();
        openSummary();
        expect(screen.getByText('要約は期限切れのためありません')).toBeTruthy();
    });
});

describe('SessionView の浄書（FinalTranscriptBar）', () => {
    it('浄書がまだなければ、今のモデルで浄書するボタンを出す', () => {
        const s = session();
        draw({ current: s });
        fireEvent.click(screen.getByRole('button', { name: /large-v3-turbo で浄書する/ }));
        expect(actions.regenerateFinalTranscript).toHaveBeenCalledWith(s.id);
    });

    it('録音中は押せず、理由を出す', () => {
        useAppStore.setState({ recordingState: 'recording', recordingSessionId: 'other' });
        draw({ current: session() });
        const button = screen.getByRole('button', { name: /で浄書する/ }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(screen.getByText('録音中は再生成できません')).toBeTruthy();
    });

    it('録音ファイルがなければ作り直せないことを出す', () => {
        draw({
            current: session({
                files: { recording: false, transcript: true, summaries: 0, liveSummary: false } as Session['files'],
            }),
        });
        expect(screen.getByText('録音ファイルがないため、再生成できません')).toBeTruthy();
    });

    it('作っている途中はそう出す', () => {
        const s = session();
        useAppStore.setState({ server: { ...initialServerStatus, transcribing: [s.id] } });
        draw({ current: s });
        expect(screen.getByText('浄書中…')).toBeTruthy();
    });

    it('浄書があれば世代と、話者分けできなかったことを出す', () => {
        const final = {
            generationId: 'g1',
            model: 'large-v3',
            generatedAt: '2026-11-17 11:00',
            diarization: 'unavailable' as const,
            speakers: 0,
            lines: [{ time: '00:00:01', text: '浄書した行です' }],
        };
        const { lines: _, ...info } = final;
        draw({ current: session({ finalTranscript: final, finalTranscripts: [info] }) });
        expect(screen.getByText('浄書済み文字起こし（large-v3・2026-11-17 11:00）')).toBeTruthy();
        expect(screen.getByText('浄書した行です')).toBeTruthy();
        expect(screen.queryByText('今日は二分探索です')).toBeNull();
        expect(screen.getByText('large-v3-turbo の浄書済み文字起こしはまだありません')).toBeTruthy();
        expect(screen.getByText(/話者分けはできませんでした/)).toBeTruthy();
        expect(screen.getByRole('button', { name: /large-v3-turbo で再生成する/ })).toBeTruthy();
    });
});

describe('SessionView の要約（SummaryPanel）', () => {
    it('今のモデルの要約を出し、コピー・共有・作り直しのボタンを並べる', () => {
        const s = session({ summaries: [summary('1')] });
        draw({ current: s });
        openSummary();
        expect(screen.getByText('gemma4:e4b で生成・2026-11-17 11:00')).toBeTruthy();
        expect(screen.getByText('要約 1')).toBeTruthy();
        expect(screen.getByRole('button', { name: /コピー/ })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /gemma4:e4b で再生成する/ }));
        expect(actions.regenerateSummary).toHaveBeenCalledWith(s.id);
    });

    it('世代が複数あれば切り替えの欄を出し、今のモデルのものを選ぶ', () => {
        draw({ current: session({ summaries: [summary('1'), summary('2', 'qwen3.5:4b')] }) });
        openSummary();
        expect(screen.getByRole('combobox', { name: '表示する要約' }).textContent).toContain('gemma4:e4b');
        expect(screen.getByText('要約 1')).toBeTruthy();
    });

    it('今のモデルの要約がなければ、いちばん新しいものを出してそう書く', () => {
        draw({ current: session({ summaries: [summary('1', 'qwen3.5:4b')] }) });
        openSummary();
        expect(screen.getByText('gemma4:e4b の要約はまだありません')).toBeTruthy();
        expect(screen.getByText('要約 1')).toBeTruthy();
    });

    it('要約がなければ作るボタンを、途中の要約があればそれを出す', () => {
        draw({ current: session() });
        openSummary();
        expect(screen.getByText('まだ要約がありません')).toBeTruthy();
        expect(screen.getByRole('button', { name: /gemma4:e4b で要約を作る/ })).toBeTruthy();
        cleanup();
        draw({ current: session({ liveSummary: '- 途中の要点' }) });
        openSummary();
        expect(screen.getByText('リアルタイム要約')).toBeTruthy();
        expect(screen.getByText('途中の要点')).toBeTruthy();
    });

    it('作れなかったことを、つながっているかで出し分ける', () => {
        draw({ current: session({ summaryFailed: true }) });
        openSummary();
        expect(screen.getByRole('alert').textContent).toContain('最終要約を作れませんでした');
        expect(screen.getByRole('alert').textContent).toContain('Ollama には今つながっています');
        cleanup();
        useAppStore.setState({ server: { ...initialServerStatus, ollama: 'error' } });
        draw({ current: session({ summaryFailed: true, summaries: [summary('1')] }) });
        openSummary();
        expect(screen.getByRole('alert').textContent).toContain('直近の要約の再生成に失敗しました');
        expect(screen.getByRole('alert').textContent).toContain('Ollama に接続できません');
    });

    it('作っている途中は、届いた本文か、今の要約を出しておく', () => {
        const s = session({ summaries: [summary('1')] });
        useAppStore.setState({ generating: { sessionId: s.id, model: 'gemma4:e4b', text: '' } });
        draw({ current: s });
        openSummary();
        expect(screen.getByText('gemma4:e4b で要約を作成中…')).toBeTruthy();
        expect(screen.getByText('今の要約（再生成した要約が届き次第差し替えます）')).toBeTruthy();
        cleanup();
        useAppStore.setState({ generating: { sessionId: s.id, model: 'gemma4:e4b', text: '届いた本文' } });
        draw({ current: s });
        openSummary();
        expect(screen.getByText('届いた本文')).toBeTruthy();
        expect(screen.queryByText('要約 1')).toBeNull();
    });
});
