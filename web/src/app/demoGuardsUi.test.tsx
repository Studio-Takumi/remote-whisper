// デモ版（#414）の画面: 止めるボタン・注意書き・バージョン・隠すもの・本文を選べなくすること
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectInfo } from '@/api/projects';
import type { Session } from '@/api/types';
import { TopBar } from '@/app/TopBar';
import { demoRefusal } from '@/app/demoGuard';
import { useAppStore } from '@/app/store';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ContextSetSheet } from '@/features/materials/ContextSetSheet';
import { MicButton } from '@/features/recording/MicButton';
import { EmptyState } from '@/features/session/EmptyState';
import { FinalTranscriptBar } from '@/features/session/FinalTranscriptBar';
import { SessionView } from '@/features/session/SessionView';
import { SummaryPanel } from '@/features/session/SummaryPanel';
import { VersionInfo } from '@/features/settings/VersionInfo';
import { defaultSettings, llmModels } from '@/features/settings/settings';

vi.mock('@/api/demoBuild', () => ({ isDemoBuild: true }));

const PROJECT: ProjectInfo = { id: 'p1', name: '講義', path: '/data/lecture' };
const initial = useAppStore.getState();
const startRecording = vi.fn(async () => {});

function session(patch: Partial<Session> = {}): Session {
    return {
        id: 's1',
        title: '第 3 回',
        startedAt: '2026-11-17T10:00:00+09:00',
        endedAt: '2026-11-17T11:00:00+09:00',
        status: 'done',
        loaded: true,
        transcript: [{ time: '00:00:01', text: '始めます' }],
        summaries: [
            {
                generationId: 'g1',
                model: llmModels(defaultSettings).detail,
                overviewModel: llmModels(defaultSettings).overview,
                generatedAt: '2026-11-17T11:05:00+09:00',
                text: '# 要約\n\n本文',
            },
        ],
        files: { recording: false, transcript: true, finalTranscripts: 0, summaries: 1, liveSummary: false },
        ...patch,
    } as Session;
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    // jsdom にないもの（タブのスクロール位置・文字起こしの高さの見張り）
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    // サイドバー（右上のバーのメニューのボタン）がスマホの幅かを見る
    window.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    info = vi.spyOn(toast, 'info');
    useAppStore.setState({ ...initial, startRecording, settings: defaultSettings });
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.restoreAllMocks();
    startRecording.mockClear();
});

function draw(ui: React.ReactNode, current?: Session) {
    const client = new QueryClient();
    client.setQueryData(['projects'], [PROJECT]);
    useAppStore.setState({
        selection: { projectId: PROJECT.id, sessionId: current?.id ?? null },
        localSessions: current ? [{ projectId: PROJECT.id, session: current }] : [],
    });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>{ui}</TooltipProvider>
        </QueryClientProvider>,
    );
}

const refused = (action: Parameters<typeof demoRefusal>[0]) =>
    expect(info).toHaveBeenCalledWith(demoRefusal(action), expect.anything());

describe('デモ版の画面', () => {
    it('最初のページは、見出しはそのままで、下に注意書きを出す', () => {
        render(<EmptyState hasProjects />);
        expect(screen.getByText('セッションを開くか、新しく録音しましょう')).toBeTruthy();
        expect(screen.getByText(/^これは Remote Whisper のデモ版です。/)).toBeTruthy();
        expect(
            screen.getByText(/いちばん上の「衆議院インターネット審議中継」にある「新しいセッション」を開くと/),
        ).toBeTruthy();
        expect(screen.getByText(/^一覧（スマホは左上のボタンで開きます）のいちばん上の/)).toBeTruthy();
        expect(screen.getByText(/ベンチマークで生成した文字起こしと要約を見られます/)).toBeTruthy();
        expect(screen.getByText(/性能を測るために公開されている動画から生成したものです。/)).toBeTruthy();
        expect(screen.queryByText(/著作権法|第30条|第40条|第47条/)).toBeNull();
        expect(screen.getByText(/政治的な立場を示すものではありません。$/)).toBeTruthy();
        expect(screen.queryByText(/プロジェクトの ＋ で新しく作れます/)).toBeNull();
    });

    it('バージョンは「Ver1.0.0 をもとにしたデモ版」', () => {
        render(<VersionInfo />);
        expect(screen.getByText('Ver1.0.0 をもとにしたデモ版')).toBeTruthy();
        expect(screen.queryByText(/クライアント/)).toBeNull();
    });

    it('マイクのボタンは、押しても録音せずにトーストで止める', () => {
        draw(<MicButton />, session());
        const button = screen.getAllByRole('button')[0];
        // 押せない見た目で、ボタンの上の説明（「押すと新しいセッション」など）は出さない
        expect(button.getAttribute('aria-label')).toBe(demoRefusal('record'));
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(screen.queryByText(/^押すと/)).toBeNull();
        fireEvent.click(button);
        refused('record');
        expect(startRecording).not.toHaveBeenCalled();
    });

    it('要約のコピーと共有は、押したらトーストで止める', () => {
        const writeText = vi.fn(async () => {});
        Object.assign(navigator, { clipboard: { writeText } });
        const s = session();
        draw(
            <SummaryPanel
                session={s}
                models={llmModels(defaultSettings)}
                generating={null}
                liveDraft={null}
                picked={null}
                onPick={() => {}}
            />,
            s,
        );
        fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
        refused('copy');
        expect(writeText).not.toHaveBeenCalled();
        info.mockClear();
        fireEvent.click(screen.getByRole('button', { name: '共有' }));
        refused('copy');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('右上のモデルは、設定のモデルのページを開く（中の変更は止める。#415）', () => {
        draw(
            <SidebarProvider>
                <TopBar />
            </SidebarProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: /^モデルの設定を開く/ }));
        expect(info).not.toHaveBeenCalled();
        expect(useAppStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: 'models' });
    });

    it('右上の参考資料は開かずに止める', () => {
        draw(<ContextSetSheet />);
        fireEvent.click(screen.getByRole('button', { name: /なし/ }));
        refused('contextSet');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('録音ファイルがない旨は出さない', () => {
        useAppStore.setState({
            options: { ...initial.options, whisper: { ...initial.options.whisper, finalTranscript: true } },
        });
        draw(<FinalTranscriptBar session={session()} making={false} />);
        expect(screen.queryByText('録音ファイルがないため、再生成できません')).toBeNull();
    });

    it('セッションの画面は「待機中」を出さず、文字起こしと要約の本文を選べなくする', () => {
        const { container } = draw(<SessionView />, session());
        expect(screen.queryByText('待機中')).toBeNull();
        expect(screen.getByText('始めます').closest('.select-none')).not.toBeNull();
        expect(container.querySelector('[role="tabpanel"]')?.closest('.select-none')).toBeNull();
    });
});
