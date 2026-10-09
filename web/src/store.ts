import { toast } from 'sonner';
import { create } from 'zustand';

import { Microphone, MicrophoneError, watchMicrophonePermission } from '@/audio/microphone';
import { AudioSender, connection } from '@/connection';
import {
    type ContextSelection,
    type ContextSet,
    type Generating,
    type Project,
    type Session,
    fallbackOptions,
    initialContextSets,
    initialProjects,
} from '@/mock';
import { fetchOptions } from '@/options';
import type { ServerMessage, SettingsOptions } from '@/protocol';
import type { RecordingState } from '@/recording';
import { type Settings, defaultSettings } from '@/settings';
import { type ServerStatus, initialServerStatus } from '@/status';
import { formatClock, formatDateTime, newId } from '@/time';

// 画面の状態をまとめて持つストア。サーバーのデータ（projects など）は、後で TanStack Query に移す想定

type Selection = { projectId: string | null; sessionId: string | null };

// partial（spec 7.2）。committed は確定した部分、tentative はまだ変わるかもしれない部分
export type LivePartial = { sessionId: string; segment: number; committed: string; tentative: string };

type AppState = {
    projects: Project[];
    selection: Selection;
    recordingState: RecordingState;
    // 録音中のセッション。録音を始めたときに作る（spec 5.2・6.2）
    recordingSessionId: string | null;
    // 録音の経過時間（秒）。一時停止中は止まる
    elapsed: number;
    // マイクの音量（RMS、0〜1）。ボタンのアニメーションに使う
    micLevel: number;
    // 送ったが ack がまだ来ていない音声のチャンクの数
    pendingAudio: number;
    // 文字起こし中の区間（partial）。final が来たら消える
    partial: LivePartial | null;
    // 届いている途中の途中の要約（summary.delta kind: live）。summary.done で session.liveSummary に移す
    liveDraft: { sessionId: string; text: string } | null;
    settings: Settings;
    // 設定で選べる値。サーバーから取れなければダミーのまま
    options: SettingsOptions;
    server: ServerStatus;
    contextSets: Record<string, ContextSet[]>;
    contextSelections: Record<string, ContextSelection>;
    generating: Generating | null;
    settingsOpen: boolean;
    newProjectOpen: boolean;
    // 開発用パネルで、プロジェクトが 0 件の状態を確かめるためのもの
    noProjects: boolean;

    loadOptions: () => Promise<void>;
    selectSession: (projectId: string, sessionId: string) => void;
    newSession: (projectId: string) => void;
    startRecording: () => Promise<void>;
    pauseRecording: () => Promise<void>;
    resumeRecording: () => void;
    stopRecording: () => Promise<void>;
    // マイクの許可の状態を見張り始める
    watchMicrophone: () => void;
    // サーバーにつなぎ、状態の通知を受け取り始める
    connectServer: () => void;
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

// 録音に使うもの。React の状態にする必要がないので外に置く
let mic: Microphone | null = null;
let sender: AudioSender | null = null;
let unsubscribe: (() => void) | null = null;
let starting = false;
let serverSubscribed = false;
// つなぎ直して resume を送り、started を待っている間
let resuming = false;
// resume の世代。切れるたびに増やし、前の接続で待っていた resume の結果は捨てる
let resumeGeneration = 0;
// resume の後、最初の ack を受けたら ack されていない音声を送り直す
let resendAfterAck = false;
// 接続が切れている間に録音を終えたセッション。つながり直したら resume して、残りの音声と stop を送る
let stoppedWhileOffline: string | null = null;

type StartedMessage = Extract<ServerMessage, { type: 'started' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;

export const useAppStore = create<AppState>()((set, get) => {
    function startElapsedTimer() {
        clearInterval(elapsedTimer);
        elapsedTimer = setInterval(() => set((s) => ({ elapsed: s.elapsed + 1 })), 1000);
    }

    // マイクを開き、サーバーに start を送り、started が来たらセッションを作る
    async function beginRecording(projectId: string) {
        closeRecording();
        stoppedWhileOffline = null;
        sender = new AudioSender((pendingAudio) => set({ pendingAudio }));
        mic = await Microphone.open((pcm, level) => {
            // 一時停止中の音声は送らない
            if (get().recordingState === 'recording') {
                sender?.push(pcm);
                set({ micLevel: level });
            }
        });
        // 接続した直後に届く status も受け取れるように、つなぐ前に購読する
        unsubscribe = connection.subscribe((m) => {
            if (m.type === 'ack') {
                sender?.ack(m.seq);
                // つなぎ直した直後の ack は、サーバーが受け取り済みの最後の連番。その次から送り直す
                if (resendAfterAck) {
                    resendAfterAck = false;
                    sender?.resend();
                    // 溜めた音声を送り終えてから、切れている間の操作を今の状態に合わせて伝える
                    if (stoppedWhileOffline) {
                        // 切れている間に録音を終えていた
                        stoppedWhileOffline = null;
                        connection.send({ type: 'stop' });
                    } else {
                        // 切れている間の一時停止・再開は届いていないので、必ず今の状態を送る
                        connection.send({ type: get().recordingState === 'paused' ? 'pause' : 'unpause' });
                    }
                }
            } else if (m.type === 'partial') {
                set({
                    partial: {
                        sessionId: m.session,
                        segment: m.segment,
                        committed: m.committed,
                        tentative: m.tentative,
                    },
                });
            } else if (m.type === 'final') {
                // 区間全体の文字起こしで、partial を置き換える
                const line = { time: formatClock(m.start), text: m.text };
                set((s) => ({
                    projects: updateSession(s.projects, m.session, (x) => ({
                        ...x,
                        transcript: [...x.transcript, line],
                    })),
                    partial: s.partial?.sessionId === m.session && s.partial.segment === m.segment ? null : s.partial,
                }));
            } else if (m.type === 'summary.delta' && m.kind === 'live') {
                // 途中の要約は毎回まるごと作り直される。summary.done で下書きを消すので、
                // その後に届いた最初の delta から、新しい下書きとして積んでいく
                set((s) => ({
                    liveDraft: {
                        sessionId: m.session,
                        text: (s.liveDraft?.sessionId === m.session ? s.liveDraft.text : '') + m.text,
                    },
                }));
            } else if (m.type === 'summary.done' && m.kind === 'live') {
                set((s) => ({
                    projects: s.liveDraft
                        ? updateSession(s.projects, m.session, (x) => ({ ...x, liveSummary: s.liveDraft?.text }))
                        : s.projects,
                    liveDraft: null,
                }));
            } else if (m.type === 'title') {
                set((s) => ({
                    projects: updateSession(s.projects, m.session, (x) => ({
                        ...x,
                        title: m.title,
                        provisionalTitle: m.provisional,
                    })),
                }));
            }
        });
        await connection.open();
        connection.send({ type: 'start', project: projectId });
        const reply = await connection.waitFor(
            (m): m is StartedMessage | ErrorMessage => m.type === 'started' || m.type === 'error',
        );
        if (reply.type === 'error') {
            throw new Error(reply.message);
        }

        // セッションは録音を始めたときに作る。ID はサーバーが決めた、録音を始めた時刻（spec 5.2）
        const created: Session = {
            id: reply.session,
            title: '新しいセッション',
            startedAt: formatDateTime(),
            status: 'recording',
            transcript: [],
            summaries: [],
        };
        set((s) => ({
            projects: s.projects.map((p) => (p.id === projectId ? { ...p, sessions: [created, ...p.sessions] } : p)),
            selection: { projectId, sessionId: created.id },
            recordingState: 'recording',
            recordingSessionId: created.id,
            elapsed: 0,
            partial: null,
            liveDraft: null,
        }));
        startElapsedTimer();
    }

    // 録音中に切れた接続がつながり直したら、resume を送って続きから録音する（spec 6.7・7.2）
    // 切れている間もマイクは止めず、音声は ack されるまで手元に溜めておく
    async function resumeAfterReconnect() {
        const sessionId = get().recordingSessionId ?? stoppedWhileOffline;
        if (!sessionId || !sender) {
            return;
        }
        const generation = ++resumeGeneration;
        resuming = true;
        resendAfterAck = false;
        try {
            connection.send({ type: 'resume', session: sessionId, nextSeq: sender.nextSeq });
            const reply = await connection.waitFor(
                (m): m is StartedMessage | ErrorMessage =>
                    (m.type === 'started' && m.session === sessionId) || m.type === 'error',
            );
            // 待っている間に切れた（またはつなぎ直した）なら、この結果は使わない
            if (generation !== resumeGeneration) {
                return;
            }
            if (reply.type === 'error') {
                if (reply.code === 'session_not_found') {
                    // サーバーが待てる時間（60秒）を過ぎた、サーバーが再起動したなど
                    interruptRecording(sessionId);
                } else {
                    retryResume(generation);
                }
                return;
            }
            // 続く ack（サーバーが受け取り済みの最後の連番）を受けたら、その次から送り直す
            resendAfterAck = true;
        } catch {
            // 応答がない。つながったままなら、少し待ってもう一度試す（切れたなら、つながり直したときに試す）
            if (generation === resumeGeneration) {
                retryResume(generation);
            }
        } finally {
            if (generation === resumeGeneration) {
                resuming = false;
            }
        }
    }

    function retryResume(generation: number) {
        setTimeout(() => {
            if (generation === resumeGeneration && connection.isOpen) {
                void resumeAfterReconnect();
            }
        }, 1000);
    }

    // 録音が途中で終わったことにする（resume できなかったとき）
    function interruptRecording(sessionId: string) {
        clearInterval(elapsedTimer);
        resendAfterAck = false;
        stoppedWhileOffline = null;
        closeRecording();
        set((s) => ({
            recordingState: 'idle',
            recordingSessionId: null,
            micLevel: 0,
            pendingAudio: 0,
            partial: null,
            liveDraft: null,
            projects: updateSession(s.projects, sessionId, (x) => ({
                ...x,
                status: 'interrupted',
                endedAt: formatDateTime(),
            })),
        }));
        toast.error(
            'サーバーで録音を続けられなくなったため、録音は途中で終わりました（接続が長く切れていた、サーバーが再起動したなど）。そこまでの録音はサーバーに残っています',
            {
                duration: 10000,
            },
        );
    }

    // マイクを閉じ、録音のためのメッセージの受け取りをやめる
    function closeRecording() {
        mic?.close();
        mic = null;
        sender = null;
        unsubscribe?.();
        unsubscribe = null;
    }

    return {
        projects: initialProjects,
        selection: { projectId: null, sessionId: null },
        recordingState: 'idle',
        recordingSessionId: null,
        elapsed: 0,
        micLevel: 0,
        pendingAudio: 0,
        partial: null,
        liveDraft: null,
        settings: defaultSettings,
        options: fallbackOptions,
        server: initialServerStatus,
        contextSets: initialContextSets,
        contextSelections: {},
        generating: null,
        settingsOpen: false,
        newProjectOpen: false,
        noProjects: false,

        loadOptions: async () => {
            try {
                const options = await fetchOptions();
                // Ollama のモデルがまだ取れないサーバー（#25 より前）では、ダミーの一覧を残す
                set({
                    options:
                        options.ollama.models.length > 0 ? options : { ...options, ollama: fallbackOptions.ollama },
                });
            } catch {
                // サーバーがないときはダミーの一覧のまま
            }
        },

        selectSession: (projectId, sessionId) => set({ selection: { projectId, sessionId } }),
        newSession: (projectId) => set({ selection: { projectId, sessionId: null } }),

        startRecording: async () => {
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
            if (s.recordingState !== 'idle' || starting) {
                return;
            }
            // 切れている間に終えた録音の残りをまだ送っていない。始めると、その残りが捨てられてしまう
            if (stoppedWhileOffline) {
                toast.warning(
                    '前の録音の残りをサーバーに送るのを待っています。サーバーにつながってから、もう一度押してください',
                );
                return;
            }
            starting = true;
            try {
                await beginRecording(project.id);
            } catch (e) {
                closeRecording();
                if (e instanceof MicrophoneError && e.reason === 'denied') {
                    set({ server: { ...get().server, microphone: 'denied' } });
                    toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
                } else {
                    toast.error((e as Error).message);
                }
                return;
            } finally {
                starting = false;
            }
        },

        // 一時停止の前までの音声を送り切ってから pause を送る
        pauseRecording: async () => {
            clearInterval(elapsedTimer);
            await mic?.flush();
            sender?.flush();
            connection.send({ type: 'pause' });
            set({ recordingState: 'paused', micLevel: 0 });
        },

        resumeRecording: () => {
            // 一時停止中に worklet に溜まった音は送らない
            mic?.discard();
            connection.send({ type: 'unpause' });
            set({ recordingState: 'recording' });
            startElapsedTimer();
        },

        // 録音を終えたら、セッションの終了日時と状態を確定して、最終の要約を作り始める
        stopRecording: async () => {
            clearInterval(elapsedTimer);
            // 終了の前までの音声（worklet と手元に溜まっている分）を送り切ってから stop を送る
            if (get().recordingState === 'recording') {
                await mic?.flush();
            }
            sender?.flush();
            const sessionId = get().recordingSessionId;
            if (sender && !sender.holding) {
                connection.send({ type: 'stop' });
            } else {
                // 切れていて音声を溜めている間は、つながり直して溜めた音声を送ってから stop を送る
                stoppedWhileOffline = sessionId;
            }
            // 最後に送った音声の ack を受け取れるように、購読は次の録音を始めるまで続ける
            mic?.close();
            mic = null;
            const endedAt = formatDateTime();
            set((s) => ({
                recordingState: 'idle',
                recordingSessionId: null,
                micLevel: 0,
                // 流れている途中で終えると summary.done（live）が来ないので、書きかけの途中の要約は捨てる
                liveDraft: null,
                projects: sessionId
                    ? updateSession(s.projects, sessionId, (x) => ({ ...x, status: 'done', endedAt }))
                    : s.projects,
            }));
            const s = get();
            const done = s.projects.flatMap((p) => p.sessions).find((x) => x.id === sessionId);
            if (done) {
                get().generateSummary(done, s.settings.ollama.finalSummaryModel);
            }
        },

        watchMicrophone: () => {
            void watchMicrophonePermission((denied) =>
                set((s) => ({ server: { ...s.server, microphone: denied ? 'denied' : 'granted' } })),
            );
        },

        // サーバーにつなぎ続け、状態（status）とエラーを受け取る（spec 7.2）
        // 接続が切れているかどうかは status に含まれないので、ブラウザ側で判定する
        connectServer: () => {
            if (serverSubscribed) {
                return;
            }
            serverSubscribed = true;
            connection.onStateChange((connected) => {
                set((s) => ({ server: { ...s.server, connection: connected ? 'connected' : 'reconnecting' } }));
                if (!get().recordingSessionId && !stoppedWhileOffline) {
                    return;
                }
                if (connected) {
                    // 録音中に切れていたら、続きから録音する
                    void resumeAfterReconnect();
                } else {
                    // 新しい接続ではセッションが resume されるまで音声を受け付けないので、それまで溜めておく
                    sender?.hold();
                    // 前の接続で待っていた resume は打ち切る
                    resumeGeneration += 1;
                    resuming = false;
                    resendAfterAck = false;
                }
            });
            connection.subscribe((m) => {
                if (m.type === 'status') {
                    // recordings と queue は今のところ画面に出さない
                    set((s) => ({ server: { ...s.server, whisper: m.whisper, ollama: m.ollama } }));
                } else if (m.type === 'error' && !starting && !resuming) {
                    // 録音を始める・続けるときのエラーは、それぞれの処理でまとめて出す
                    toast.error(m.message);
                }
            });
            connection.start();
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

// 開発中は、ブラウザの開発者ツールや Playwright からストアを見られるようにする
if (import.meta.env.DEV) {
    Object.assign(window, { appStore: useAppStore });
}
