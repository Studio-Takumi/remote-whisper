import { toast } from 'sonner';
import { create } from 'zustand';

import {
    type ContextSelection,
    type ContextSet,
    type Generating,
    type Project,
    type Session,
    initialContextSets,
    initialProjects,
} from '@/mock';
import type { RecordingState } from '@/recording';
import { type Settings, defaultSettings } from '@/settings';
import { type ServerStatus, initialServerStatus } from '@/status';
import { formatDateTime, newId } from '@/time';

// 画面の状態をまとめて持つストア。サーバーのデータ（projects など）は、後で TanStack Query に移す想定

type Selection = { projectId: string | null; sessionId: string | null };

type AppState = {
    projects: Project[];
    selection: Selection;
    recordingState: RecordingState;
    // 録音の経過時間（秒）。一時停止中は止まる
    elapsed: number;
    settings: Settings;
    server: ServerStatus;
    contextSets: Record<string, ContextSet[]>;
    contextSelections: Record<string, ContextSelection>;
    generating: Generating | null;
    settingsOpen: boolean;
    newProjectOpen: boolean;
    // 開発用パネルで、プロジェクトが 0 件の状態を確かめるためのもの
    noProjects: boolean;

    selectSession: (projectId: string, sessionId: string) => void;
    newSession: (projectId: string) => void;
    startRecording: () => void;
    pauseRecording: () => void;
    resumeRecording: () => void;
    stopRecording: () => void;
    changeSettings: (settings: Settings) => void;
    generateSummary: (session: Session, model: string) => void;
    changeContextSelection: (selection: ContextSelection) => void;
    createContextSet: (materials: string[]) => void;
    setServer: (server: ServerStatus) => void;
    setSettingsOpen: (open: boolean) => void;
    setNewProjectOpen: (open: boolean) => void;
    setNoProjects: (noProjects: boolean) => void;
};

// 選択中のものを取り出すセレクタ。毎回同じ参照を返すように、空のときも定数を返す
const NO_PROJECTS: Project[] = [];
const NO_SETS: ContextSet[] = [];

export const visibleProjects = (s: AppState) => (s.noProjects ? NO_PROJECTS : s.projects);
export const currentProject = (s: AppState) => visibleProjects(s).find((p) => p.id === s.selection.projectId);
export const currentSession = (s: AppState) => currentProject(s)?.sessions.find((x) => x.id === s.selection.sessionId);
export const currentContextSets = (s: AppState) => {
    const project = currentProject(s);
    return project ? (s.contextSets[project.id] ?? NO_SETS) : NO_SETS;
};
// 新しいオブジェクトを返すことがあるので、使うときは useShallow で包む
export const currentContextSelection = (s: AppState): ContextSelection => {
    const project = currentProject(s);
    return (
        (project && s.contextSelections[project.id]) ?? {
            setId: currentContextSets(s).find((x) => x.status === 'ready')?.id ?? null,
            useHotwords: true,
            useContext: true,
        }
    );
};

function updateSession(projects: Project[], sessionId: string, fn: (s: Session) => Session) {
    return projects.map((p) => ({ ...p, sessions: p.sessions.map((s) => (s.id === sessionId ? fn(s) : s)) }));
}

// タイマーは React の外で回す
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let generationTimer: ReturnType<typeof setInterval> | undefined;

export const useAppStore = create<AppState>()((set, get) => {
    function startElapsedTimer() {
        clearInterval(elapsedTimer);
        elapsedTimer = setInterval(() => set((s) => ({ elapsed: s.elapsed + 1 })), 1000);
    }

    return {
        projects: initialProjects,
        selection: { projectId: null, sessionId: null },
        recordingState: 'idle',
        elapsed: 0,
        settings: defaultSettings,
        server: initialServerStatus,
        contextSets: initialContextSets,
        contextSelections: {},
        generating: null,
        settingsOpen: false,
        newProjectOpen: false,
        noProjects: false,

        selectSession: (projectId, sessionId) => set({ selection: { projectId, sessionId } }),
        newSession: (projectId) => set({ selection: { projectId, sessionId: null } }),

        startRecording: () => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                toast.info('録音するプロジェクトを左のメニューから選んでください');
                return;
            }
            // 既存のセッションを開いていたら、同じプロジェクトの新しいセッションの画面に切り替えるだけにする
            // 録音を始める前に、モデルや参考資料を選び直せるようにするため
            if (currentSession(s)) {
                set({ selection: { projectId: project.id, sessionId: null } });
                return;
            }
            if (s.server.microphone === 'denied') {
                toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
                return;
            }
            set({ recordingState: 'recording', elapsed: 0 });
            startElapsedTimer();
            // Whisper は録音を始めたときに読み込む（spec 6.2 節）
            if (s.server.whisper === 'unloaded') {
                set({ server: { ...s.server, whisper: 'loading' } });
                setTimeout(() => {
                    const server = get().server;
                    if (server.whisper === 'loading') {
                        set({ server: { ...server, whisper: 'ready' } });
                    }
                }, 2000);
            }
        },

        pauseRecording: () => {
            clearInterval(elapsedTimer);
            set({ recordingState: 'paused' });
        },

        resumeRecording: () => {
            set({ recordingState: 'recording' });
            startElapsedTimer();
        },

        // 録音を終えたら、セッションを作って開き、最終の要約を作り始める
        stopRecording: () => {
            clearInterval(elapsedTimer);
            const s = get();
            set({ recordingState: 'idle' });
            const project = currentProject(s);
            if (!project) {
                return;
            }
            const now = new Date();
            const created: Session = {
                id: newId(now),
                title: '新しいセッション',
                startedAt: formatDateTime(now),
                status: 'done',
                transcript: [],
                summaries: [],
            };
            set({
                projects: s.projects.map((p) =>
                    p.id === project.id ? { ...p, sessions: [created, ...p.sessions] } : p,
                ),
                selection: { projectId: project.id, sessionId: created.id },
            });
            get().generateSummary(created, s.settings.ollama.finalSummaryModel);
        },

        // 簡易設定・設定モーダルのどちらからでも呼ぶ。最終の要約のモデルを変えたとき、そのモデルの要約がなければ作る
        changeSettings: (next) => {
            const s = get();
            const session = currentSession(s);
            const model = next.ollama.finalSummaryModel;
            set({ settings: next });
            if (
                model !== s.settings.ollama.finalSummaryModel &&
                session &&
                !session.summaries.some((x) => x.model === model)
            ) {
                get().generateSummary(session, model);
            }
        },

        // 最終の要約を作る（ダミー）。少しずつ文字を足して、ストリーミングで届く様子をまねる
        generateSummary: (target, model) => {
            if (get().server.ollama === 'error') {
                toast.error('Ollama に接続できないため、要約を作れません');
                return;
            }
            clearInterval(generationTimer);
            const base = target.summaries.at(-1)?.text ?? '## 要約\n- 文字起こしが短いため、要約する内容がありません';
            const full = `${base}\n\n> ${model} で作ったダミーの要約です`;
            let length = 0;
            set({ generating: { sessionId: target.id, model, text: '' } });
            generationTimer = setInterval(() => {
                length += 6;
                if (length < full.length) {
                    set({ generating: { sessionId: target.id, model, text: full.slice(0, length) } });
                    return;
                }
                clearInterval(generationTimer);
                const summary = { generationId: newId(), model, generatedAt: formatDateTime(), text: full };
                set((s) => ({
                    generating: null,
                    projects: updateSession(s.projects, target.id, (x) => ({
                        ...x,
                        summaries: [...x.summaries, summary],
                    })),
                }));
            }, 50);
        },

        changeContextSelection: (next) => {
            const project = currentProject(get());
            if (project) {
                set((s) => ({ contextSelections: { ...s.contextSelections, [project.id]: next } }));
            }
        },

        // 同じ資料の組み合わせのセットがあれば、作り直さずに使い回す（spec 6.6 節）
        createContextSet: (materials) => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                return;
            }
            const pid = project.id;
            const selection = currentContextSelection(s);
            const same = currentContextSets(s).find((x) => x.materials.join('\n') === materials.join('\n'));
            if (same) {
                get().changeContextSelection({ ...selection, setId: same.id });
                toast.info('同じ資料で作ったセットがあるので、それを使います');
                return;
            }
            const created: ContextSet = { id: newId(), status: 'generating', materials };
            set((st) => ({ contextSets: { ...st.contextSets, [pid]: [...(st.contextSets[pid] ?? []), created] } }));
            get().changeContextSelection({ ...selection, setId: created.id });
            setTimeout(() => {
                set((st) => ({
                    contextSets: {
                        ...st.contextSets,
                        [pid]: (st.contextSets[pid] ?? []).map((x) =>
                            x.id === created.id ? { ...x, status: 'ready' } : x,
                        ),
                    },
                }));
                toast.success('参考資料セットができました');
            }, 4000);
        },

        setServer: (server) => set({ server }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
        setNoProjects: (noProjects) => set({ noProjects }),
    };
});
