import { toast } from 'sonner';
import { create } from 'zustand';

import { ApiError, type ProjectJson, type TermsJson, api } from '@/api';
import { type MicState, Microphone, MicrophoneError, SAMPLE_RATE, watchMicrophonePermission } from '@/audio/microphone';
import { type UnsentSession, clearSession, deleteUpTo, listUnsent, restoreSize, saveChunk } from '@/audio/unsentStore';
import { keepScreenOn, screenKeptOn } from '@/audio/wakeLock';
import { AudioSender, connection } from '@/connection';
import {
    fetchContextSets,
    fetchFinalTranscript,
    fetchProjects,
    fetchSessionDetail,
    isDemo,
    mergeProjects,
    toSelection,
} from '@/data';
import { demoProjects, fallbackOptions, initialContextSets } from '@/mock';
import { fetchOptions } from '@/options';
import type { ServerMessage, SettingsOptions } from '@/protocol';
import type { RecordingState } from '@/recording';
import { type Settings, defaultSettings } from '@/settings';
import { type ServerStatus, initialServerStatus } from '@/status';
import { formatClock, formatDateTime, newId } from '@/time';
import type { ContextSelection, ContextSet, Generating, Project, Session } from '@/types';
import type { VersionJson } from '@/version';

// 画面の状態をまとめて持つストア。プロジェクト・セッション・設定はサーバーの API から取る（spec 7.1）

type Selection = { projectId: string | null; sessionId: string | null };

// partial（spec 7.2）。committed は確定した部分、tentative はまだ変わるかもしれない部分
export type LivePartial = { sessionId: string; segment: number; committed: string; tentative: string };

type AppState = {
    projects: Project[];
    selection: Selection;
    recordingState: RecordingState;
    // 録音中のセッション。録音を始めたときに作る（spec 5.2・6.2）
    recordingSessionId: string | null;
    // 録音の経過時間（秒）。録音した音声の長さで、一時停止中は止まる
    elapsed: number;
    // マイクの音量（RMS、0〜1）。ボタンのアニメーションに使う
    micLevel: number;
    // 録音中のマイクの状態（止まっていないか。#102）
    micState: MicState;
    // 音は届いているのに、しばらく文字起こしが出ていない（サーバーが知らせる。#120）
    transcriptionStalled: boolean;
    // 送ったが ack がまだ来ていない音声のチャンクの数
    pendingAudio: number;
    // 文字起こし中の区間（partial）。final が来たら消える
    partial: LivePartial | null;
    // 届いている途中の途中の要約（summary.delta kind: live）。summary.done で session.liveSummary に移す
    liveDraft: { sessionId: string; text: string } | null;
    settings: Settings;
    // 設定で選べる値。サーバーから取れなければダミーのまま
    options: SettingsOptions;
    // サーバーのバージョン（コミットハッシュ）。取れていなければ null
    serverVersion: string | null;
    server: ServerStatus;
    contextSets: Record<string, ContextSet[]>;
    contextSelections: Record<string, ContextSelection>;
    generating: Generating | null;
    settingsOpen: boolean;
    newProjectOpen: boolean;
    // 開発用パネルで、プロジェクトが 0 件の状態を確かめるためのもの
    noProjects: boolean;

    loadOptions: () => Promise<void>;
    loadSettings: () => Promise<void>;
    // プロジェクトとセッションの一覧を取り直す
    loadProjects: () => Promise<void>;
    // ディレクトリをプロジェクトとして登録する（POST /api/projects）
    createProject: (path: string) => Promise<void>;
    selectSession: (projectId: string, sessionId: string) => void;
    newSession: (projectId: string) => void;
    startRecording: () => Promise<void>;
    // 途中で終わったセッションの続きを、同じセッションのまま録音する（#101）
    continueRecording: (sessionId: string) => Promise<void>;
    // 止まったマイクを開き直す（録音はそのまま続ける。#102）
    reopenMicrophone: () => Promise<void>;
    // 拾った語を消す（誤った語。以後そのセッションでは足さない。#103）
    rejectTerm: (sessionId: string, term: string) => Promise<void>;
    // ページを読み込み直す前に、サーバーに届かなかった音声（IndexedDB に置いてあったもの。#102）
    unsent: { sessionId: string; projectId: string; seconds: number } | null;
    // 届かなかった音声を送り、同じセッションの続きを録音する
    recoverUnsent: () => Promise<void>;
    // 届かなかった音声を捨てる
    discardUnsent: () => Promise<void>;
    pauseRecording: () => Promise<void>;
    resumeRecording: () => void;
    stopRecording: () => Promise<void>;
    // マイクの許可の状態を見張り始める
    watchMicrophone: () => void;
    // サーバーにつなぎ、状態の通知を受け取り始める
    connectServer: () => void;
    changeSettings: (settings: Settings) => Promise<boolean>;
    // 今の全体設定（finalSummaryModel）で、最終の要約を作り直す（POST .../summaries）
    regenerateSummary: (sessionId: string) => Promise<void>;
    changeContextSelection: (selection: ContextSelection) => Promise<void>;
    createContextSet: (materials: string[]) => Promise<void>;
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

// 録音を終えていて文字起こしがあるのに、そのモデルの最終の要約がまだないか（作り直すかどうか）
export function needsSummaryFor(session: Session, model: string) {
    return (
        session.loaded === true &&
        session.status !== 'recording' &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        !session.summaries.some((x) => x.model === model)
    );
}
export const currentContextSets = (s: AppState) => {
    const project = currentProject(s);
    return project ? (s.contextSets[project.id] ?? NO_SETS) : NO_SETS;
};
// 新しいオブジェクトを返すことがあるので、使うときは useShallow で包む
export const currentContextSelection = (s: AppState): ContextSelection => {
    const project = currentProject(s);
    // 手元で変えたもの → サーバーに保存されているもの → 既定（ready のうち最初に作ったもの）
    return (
        (project && (s.contextSelections[project.id] ?? project.selection)) ?? {
            setId: currentContextSets(s).find((x) => x.status === 'ready')?.id ?? null,
            useHotwords: true,
            useContext: true,
            pickTerms: true,
        }
    );
};

function updateSession(projects: Project[], sessionId: string, fn: (s: Session) => Session) {
    return projects.map((p) => ({ ...p, sessions: p.sessions.map((s) => (s.id === sessionId ? fn(s) : s)) }));
}

// デモ（?demo）ではサーバーに保存されないので、届いた最終の要約をそのままセッションに足す
function finishDemoSummary(s: AppState, sessionId: string): Partial<AppState> {
    if (s.generating?.sessionId !== sessionId) {
        return {};
    }
    const { model, text } = s.generating;
    const summary = { generationId: newId(), model, generatedAt: formatDateTime(), text };
    return {
        generating: null,
        projects: updateSession(s.projects, sessionId, (x) => ({ ...x, summaries: [...x.summaries, summary] })),
    };
}

// 録音した（サーバーに送る）サンプルの数。経過時間はこれから出す（spec 6.2）
// サーバーは受け取ったサンプルの数から文字起こしの時刻を出すので、同じ時計になる。
// setInterval で数えると、裏に回したタブでタイマーが間引かれてずれていく
let recordedSamples = 0;
// サーバー全体で録音中のセッションの数（status の recordings）。変わったら一覧を取り直す（ほかの端末の録音を出すため）
let lastRecordings = -1;
// 最終の要約ができて、サーバーに保存されたもので置き換えるセッション（取り直しで手元のものを残さない）
let releasing: string | null = null;
// 最終の要約ができたので取り直しているセッション（title と status の両方から呼ばれても1回にする）
const reloadingSummaries = new Set<string>();
// サーバーが最終の要約を作っているセッション（直近の status の summarizing。古いサーバーでは null）。#118
let summarizing: Set<string> | null = null;
// つながってから、まだ status を受け取っていない。つながり直した直後の status には、
// 切れている間に作り終えたことが含まれる（title を取りこぼしていても、ここで気づける）
let freshConnection = false;
// summarizing から外れた（作り終えた）セッション。作り直しの返事より先に作り終えたときに使う
const finishedSummaries = new Set<string>();

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
// 録音が途中で終わったとき、サーバーに届かなかった音声。そのセッションの続きを録音するときに先に送る（#101）
// （ページを読み込み直すと消える）
let leftover: { sessionId: string; pcm: Int16Array[] } | null = null;
// ページを読み込み直す前に溜めていた音声（IndexedDB から読んだもの。#102）
let unsentEntry: UnsentSession | null = null;
// 読み込み直した後に resume したとき、サーバーが受け取り済みの録音の長さ（サンプル数）。最初の ack で使う
let recoveredBase: number | null = null;

type StartedMessage = Extract<ServerMessage, { type: 'started' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;

export const useAppStore = create<AppState>()((set, get) => {
    // 送る音声を数えて、経過時間を進める。接続が切れて手元に溜めている分も、録音した長さとして数える
    function countRecorded(pcm: Int16Array) {
        recordedSamples += pcm.length;
        const elapsed = Math.floor(recordedSamples / SAMPLE_RATE);
        if (elapsed !== get().elapsed) {
            set({ elapsed });
        }
    }

    // マイクを開く。届いた音声を送り、マイクが止まったら画面で知らせる（#102）。
    // 状態は開けたときに最初の知らせで決まる（開き直しに失敗したら、止まったままの警告を残す）
    function openMicrophone() {
        // 古いサーバーは echoCancellation を返さない（そのときはオン）
        const { noiseSuppression, autoGainControl, echoCancellation = true } = get().settings.recording;
        return Microphone.open(
            (pcm, level) => {
                // 一時停止中の音声は送らない
                if (get().recordingState === 'recording' && sender) {
                    sender.push(pcm);
                    countRecorded(pcm);
                    set({ micLevel: level });
                }
            },
            { noiseSuppression, autoGainControl, echoCancellation },
            (micState) => {
                const before = get().micState;
                set({ micState });
                if (micState !== 'ok' && before === 'ok' && get().recordingState !== 'idle') {
                    toast.error(micStateMessage(micState), { duration: 15000 });
                }
            },
        );
    }

    // 録音のためのメッセージ（ack・partial・final・途中の要約）を受け取る。
    // 接続した直後に届く status も受け取れるように、つなぐ前に呼ぶ
    function subscribeRecording() {
        return connection.subscribe((m) => {
            if (m.type === 'ack') {
                sender?.ack(m.seq);
                // つなぎ直した直後の ack は、サーバーが受け取り済みの最後の連番。その次から送り直す
                if (resendAfterAck) {
                    resendAfterAck = false;
                    // ページを読み込み直した後なら、サーバーが受け取り済みの分を ack で除いてから経過時間を戻す
                    if (recoveredBase !== null && sender) {
                        recordedSamples = recoveredBase + sender.unsentSamples;
                        recoveredBase = null;
                        set({ elapsed: Math.floor(recordedSamples / SAMPLE_RATE) });
                    }
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
            } else if (m.type === 'transcriptionStalled') {
                if (m.stalled && !get().transcriptionStalled) {
                    toast.warning(stalledMessage, { duration: 15000 });
                }
                set({ transcriptionStalled: m.stalled });
            } else if (m.type === 'final') {
                // 区間全体の文字起こしで、partial を置き換える。text が空なら文字にならなかった区間なので、partial を消すだけ（#89）
                const line = { time: formatClock(m.start), text: m.text };
                set((s) => ({
                    projects: m.text
                        ? updateSession(s.projects, m.session, (x) => ({
                              ...x,
                              transcript: [...x.transcript, line],
                          }))
                        : s.projects,
                    partial: s.partial?.sessionId === m.session && s.partial.segment === m.segment ? null : s.partial,
                }));
            } else if (
                (m.type === 'summary.delta' || m.type === 'summary.done') &&
                m.kind === 'live' &&
                get().recordingSessionId !== m.session
            ) {
                // 録音を終えた後に届いた途中の要約は出さない（もう最終の要約を作成中と出している）
            } else if (m.type === 'summary.delta' && m.kind === 'live') {
                // 途中の要約は毎回まるごと作り直される。summary.done で下書きを消すので、
                // その後に届いた最初の delta から、新しい下書きとして積んでいく
                set((s) => ({
                    liveDraft: {
                        sessionId: m.session,
                        text: (s.liveDraft?.sessionId === m.session ? s.liveDraft.text : '') + m.text,
                    },
                }));
            } else if (m.type === 'terms') {
                // 録音中に拾った語が変わった（#103）
                set((s) => ({
                    projects: updateSession(s.projects, m.session, (x) => ({ ...x, pickedTerms: m.terms })),
                }));
            } else if (m.type === 'summary.done' && m.kind === 'live') {
                set((s) => ({
                    projects: s.liveDraft
                        ? updateSession(s.projects, m.session, (x) => ({ ...x, liveSummary: s.liveDraft?.text }))
                        : s.projects,
                    liveDraft: null,
                }));
            }
            // 最終の要約・タイトル・要約の失敗は、作り直し（ほかの端末から頼んだものも）でも届くので、
            // 録音ごとではなく、常時の購読（connectServer）で受け取る
        });
    }

    // 届いていない音声を IndexedDB に置き、サーバーが受け取ったら消す（#102）
    function persistUnsent(target: AudioSender, sessionId: string, projectId: string) {
        let warned = false;
        target.onFrame = (seq, frame) => {
            void saveChunk(sessionId, projectId, seq, frame).then((saved) => {
                if (!saved && !warned) {
                    warned = true;
                    toast.warning(
                        'サーバーに届いていない音声が多すぎるため、これより後はページを読み込み直すと消えます。ページを閉じずに、つながるのを待ってください',
                    );
                }
            });
        };
        target.onAcked = (seq) => void deleteUpTo(sessionId, seq);
    }

    // continueSessionId を渡すと、途中で終わったそのセッションの続きを録音する
    async function beginRecording(projectId: string, continueSessionId?: string) {
        closeRecording();
        stoppedWhileOffline = null;
        sender = new AudioSender((pendingAudio) => set({ pendingAudio }));
        mic = await openMicrophone();
        unsubscribe = subscribeRecording();
        await connection.open();
        connection.send(
            continueSessionId
                ? { type: 'continue', project: projectId, session: continueSessionId }
                : { type: 'start', project: projectId },
        );
        const reply = await connection.waitFor(
            (m): m is StartedMessage | ErrorMessage => m.type === 'started' || m.type === 'error',
            // 続きを録音するときは、サーバーが前の録音（mp3）を WAV に戻すので、長い録音ほど時間がかかる
            continueSessionId ? 60000 : 5000,
        );
        if (reply.type === 'error') {
            throw new Error(reply.message);
        }

        if (continueSessionId) {
            // 続きを録音する。経過時間と文字起こしの時刻は、前の録音の長さから続ける（#101）
            recordedSamples = Math.round((reply.offsetSec ?? 0) * SAMPLE_RATE);
            set((s) => ({
                projects: updateSession(s.projects, continueSessionId, (x) => ({
                    ...x,
                    status: 'recording',
                    endedAt: undefined,
                    durationSec: undefined,
                })),
                selection: { projectId, sessionId: continueSessionId },
                recordingState: 'recording',
                recordingSessionId: continueSessionId,
                elapsed: Math.floor(recordedSamples / SAMPLE_RATE),
                partial: null,
                liveDraft: null,
            }));
            // 切れている間に録音した分（サーバーに届かなかった音声）を、続きの頭に送る。
            // IndexedDB に置いてあった分は、新しい連番で置き直す
            await clearSession(continueSessionId);
            if (sender) {
                persistUnsent(sender, continueSessionId, projectId);
            }
            if (leftover?.sessionId === continueSessionId && sender) {
                for (const pcm of leftover.pcm) {
                    sender.push(pcm);
                    countRecorded(pcm);
                }
            }
            leftover = null;
            return;
        }

        // セッションは録音を始めたときに作る。ID はサーバーが決めた、録音を始めた時刻（spec 5.2）
        const created: Session = {
            id: reply.session,
            title: '新しいセッション',
            startedAt: formatDateTime(),
            status: 'recording',
            loaded: true,
            transcript: [],
            summaries: [],
        };
        recordedSamples = 0;
        if (sender) {
            persistUnsent(sender, created.id, projectId);
        }
        set((s) => ({
            // 先に一覧の取り直しでサーバーのものが入っていることがあるので、同じ ID のものは置き換える
            projects: s.projects.map((p) =>
                p.id === projectId
                    ? { ...p, sessions: [created, ...p.sessions.filter((x) => x.id !== created.id)] }
                    : p,
            ),
            selection: { projectId, sessionId: created.id },
            recordingState: 'recording',
            recordingSessionId: created.id,
            elapsed: 0,
            partial: null,
            liveDraft: null,
        }));
    }

    // 録音を始める（continueSessionId があれば、途中で終わったそのセッションの続きを録音する）
    async function startOrContinue(projectId: string, continueSessionId?: string) {
        starting = true;
        try {
            await beginRecording(projectId, continueSessionId);
        } catch (e) {
            closeRecording();
            if (e instanceof MicrophoneError && e.reason === 'denied') {
                set({ server: { ...get().server, microphone: 'denied' } });
                toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
            } else {
                toast.error((e as Error).message);
            }
        } finally {
            starting = false;
        }
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
                    // サーバーが待てる時間（recording.resumeTimeoutMin）を過ぎた、サーバーが再起動したなど
                    interruptRecording(sessionId);
                } else {
                    retryResume();
                }
                return;
            }
            // 続く ack（サーバーが受け取り済みの最後の連番）を受けたら、その次から送り直す
            resendAfterAck = true;
        } catch {
            // 応答がない（切れたなら、つながり直したときにもう一度試す）
            if (generation === resumeGeneration) {
                retryResume();
            }
        } finally {
            if (generation === resumeGeneration) {
                resuming = false;
            }
        }
    }

    // resume がうまくいかなかったら、接続を切ってつなぎ直す。つながったら、もう一度 resume する
    // 同じ接続でやり直さないのは、遅れて届いた started で、サーバーがこの接続にセッションを付けているかもしれないため
    function retryResume() {
        connection.drop();
    }

    // 録音が途中で終わったことにする（resume できなかったとき）
    function interruptRecording(sessionId: string) {
        resendAfterAck = false;
        stoppedWhileOffline = null;
        // 切れている間に録音してサーバーに届かなかった音声は、続きを録音するときに頭に足す（#101）
        if (sender) {
            leftover = { sessionId, pcm: sender.unsent() };
        }
        closeRecording();
        set((s) => ({
            recordingState: 'idle',
            recordingSessionId: null,
            micLevel: 0,
            transcriptionStalled: false,
            pendingAudio: 0,
            partial: null,
            liveDraft: null,
            projects: updateSession(s.projects, sessionId, (x) => ({
                ...x,
                status: 'interrupted',
                endedAt: formatDateTime(),
            })),
        }));
        // 同じセッションのまま続きを録音できる（#101）。セッションの画面にも「続きから録音」を出す
        toast.error(
            'サーバーで録音を続けられなくなったため、録音は途中で終わりました（接続が長く切れていた、サーバーが再起動したなど）。そこまでの録音はサーバーに残っています',
            {
                duration: 15000,
                action: { label: '続きから録音', onClick: () => void get().continueRecording(sessionId) },
            },
        );
    }

    // サーバーのバージョンを取る（起動したときと、つながり直したとき。サーバーが入れ替わっているかもしれないため）
    async function loadServerVersion() {
        if (isDemo) {
            return;
        }
        try {
            set({ serverVersion: (await api.get<VersionJson>('/api/version')).version });
        } catch {
            // 取れなければ前の値のまま
        }
    }

    // プロジェクトごとの参考資料セットの一覧を取る。取れなかったプロジェクトは入れない（前の一覧のまま）
    async function loadContextSets(projectIds: string[]) {
        const results = await Promise.allSettled(projectIds.map((id) => fetchContextSets(id)));
        const sets: Record<string, ContextSet[]> = {};
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                sets[projectIds[i]] = r.value;
            }
        });
        return sets;
    }

    async function refreshContextSets(projectIds: string[]) {
        const sets = await loadContextSets(projectIds);
        set((s) => ({ contextSets: { ...s.contextSets, ...sets } }));
    }

    // 最終の要約ができたら、一覧とセッションの中身をサーバーから取り直す
    async function reloadAfterFinalSummary(sessionId: string) {
        if (isDemo) {
            set((s) => finishDemoSummary(s, sessionId));
            return;
        }
        if (reloadingSummaries.has(sessionId)) {
            return;
        }
        reloadingSummaries.add(sessionId);
        try {
            // このセッションは手元で積み上げたものを捨てて、サーバーに保存されたもので置き換える
            releasing = sessionId;
            try {
                await get().loadProjects();
            } finally {
                releasing = null;
            }
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            const session = project?.sessions.find((x) => x.id === sessionId);
            if (project && session && !session.loaded) {
                await loadSession(project.id, session);
            }
            set((s) => ({ generating: s.generating?.sessionId === sessionId ? null : s.generating }));
        } finally {
            reloadingSummaries.delete(sessionId);
        }
    }

    // status の summarizing を受け取った。「作成中」のセッションの要約をサーバーが作り終えていたら、
    // 保存されたものを取り直して「作成中」を消す（結果のメッセージを取りこぼしても残らないように。#118）
    function receiveSummarizing(list: string[]) {
        const before = summarizing;
        const fresh = freshConnection;
        summarizing = new Set(list);
        freshConnection = false;
        for (const id of before ?? []) {
            if (!summarizing.has(id)) {
                finishedSummaries.add(id);
            }
        }
        for (const id of summarizing) {
            finishedSummaries.delete(id);
        }
        const s = get();
        const id = s.generating?.sessionId;
        // 作っている途中か、まだ始まっていない（録音中・切れている間に止めて、stop をまだ送っていない）
        if (!id || summarizing.has(id) || id === s.recordingSessionId || id === stoppedWhileOffline) {
            return;
        }
        // 作っていたのに外れた・つながり直したらもう作っていなかった。
        // （止めた直後に、止める前の status が遅れて届いたときは、どちらでもないので何もしない）
        if (before?.has(id) || fresh) {
            void reloadAfterFinalSummary(id);
        }
    }

    async function receiveFinalTranscript(sessionId: string) {
        const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
        if (!project) {
            // まだ一覧にない（ほかの端末のセッションなど）
            void get().loadProjects();
            return;
        }
        try {
            const finalTranscript = await fetchFinalTranscript(project.id, sessionId);
            set((s) => ({
                projects: updateSession(s.projects, sessionId, (x) => ({
                    ...x,
                    finalTranscript,
                    files: x.files && { ...x.files, finalTranscripts: (x.files.finalTranscripts ?? 0) + 1 },
                })),
            }));
        } catch {
            // 取れなければ、次に一覧を取り直したときに出る
        }
    }

    // セッションの文字起こしと要約を取ってくる（開いたとき）
    async function loadSession(projectId: string, session: Session) {
        try {
            const detail = await fetchSessionDetail(projectId, session);
            set((s) => ({
                projects: updateSession(s.projects, session.id, (x) => ({ ...x, ...detail, loaded: true })),
            }));
        } catch (e) {
            toast.error(`セッションを読み込めません: ${(e as Error).message}`);
            // 「読み込んでいます…」のままにしない
            set((s) => ({ projects: updateSession(s.projects, session.id, (x) => ({ ...x, loaded: true })) }));
        }
    }

    // マイクを閉じ、録音のためのメッセージの受け取りをやめる
    function closeRecording() {
        mic?.close();
        mic = null;
        sender = null;
        recoveredBase = null;
        unsubscribe?.();
        unsubscribe = null;
    }

    return {
        projects: isDemo ? demoProjects : [],
        selection: { projectId: null, sessionId: null },
        recordingState: 'idle',
        recordingSessionId: null,
        elapsed: 0,
        micLevel: 0,
        micState: 'ok',
        transcriptionStalled: false,
        unsent: null,
        pendingAudio: 0,
        partial: null,
        liveDraft: null,
        settings: defaultSettings,
        options: fallbackOptions,
        serverVersion: null,
        server: initialServerStatus,
        // デモではダミーのセット。サーバーにつなぐときは、プロジェクトの一覧と一緒に取る
        contextSets: isDemo ? initialContextSets : {},
        contextSelections: {},
        generating: null,
        settingsOpen: false,
        newProjectOpen: false,
        noProjects: false,

        loadOptions: async () => {
            try {
                // デモでは、ダミーの一覧のまま
                if (isDemo) {
                    return;
                }
                // Ollama につながらないときは、Ollama のモデルは空の一覧になる（今の設定値は選択肢に足して出す）
                set({ options: await fetchOptions() });
            } catch {
                // サーバーがないときはダミーの一覧のまま
            }
        },

        loadSettings: async () => {
            if (isDemo) {
                return;
            }
            try {
                set({ settings: await api.get<Settings>('/api/settings') });
            } catch (e) {
                toast.error(`設定を読み込めません: ${(e as Error).message}`);
            }
        },

        loadProjects: async () => {
            if (isDemo) {
                return;
            }
            try {
                const projects = await fetchProjects();
                // 参考資料セットの一覧も取り直す（プロジェクトの数は多くないので、まとめて取る）
                const sets = await loadContextSets(projects.map((p) => p.id));
                set((s) => {
                    // 手元で中身を積み上げているセッションは、取り直しで消さない
                    const keep = new Set(
                        [s.recordingSessionId, s.generating?.sessionId, stoppedWhileOffline].filter(
                            (id): id is string => !!id && id !== releasing,
                        ),
                    );
                    return {
                        projects: mergeProjects(s.projects, projects, keep),
                        contextSets: { ...s.contextSets, ...sets },
                    };
                });
            } catch (e) {
                toast.error(`プロジェクトを読み込めません: ${(e as Error).message}`);
                return;
            }
            // 開いているセッションの中身が取り直しで無くなっていたら、読み直す
            const s = get();
            const project = currentProject(s);
            const session = currentSession(s);
            if (project && session && !session.loaded) {
                await loadSession(project.id, session);
            }
        },

        createProject: async (path) => {
            try {
                const project = await api.post<ProjectJson>('/api/projects', { path });
                await get().loadProjects();
                set({ selection: { projectId: project.id, sessionId: null } });
                toast.success(`${project.path} をプロジェクトにしました`);
            } catch (e) {
                toast.error(`プロジェクトにできません: ${(e as Error).message}`);
            }
        },

        selectSession: (projectId, sessionId) => {
            set({ selection: { projectId, sessionId } });
            const session = get()
                .projects.find((p) => p.id === projectId)
                ?.sessions.find((x) => x.id === sessionId);
            if (!isDemo && session && !session.loaded) {
                void loadSession(projectId, session);
            }
        },
        newSession: (projectId) => set({ selection: { projectId, sessionId: null } }),

        startRecording: async () => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                toast.info('録音するプロジェクトをメニューから選んでください');
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
            await startOrContinue(project.id);
        },

        recoverUnsent: async () => {
            const entry = unsentEntry;
            if (!entry || get().recordingState !== 'idle' || starting) {
                return;
            }
            starting = true;
            resuming = true;
            const { session: sessionId, project: projectId } = entry;
            try {
                closeRecording();
                stoppedWhileOffline = null;
                // 溜めていたチャンクのまま、同じ連番で送り直す（サーバーが受け取り済みの分は ack の後で捨てる）
                sender = AudioSender.restore(entry.frames, (pendingAudio) => set({ pendingAudio }));
                restoreSize(sessionId, entry.frames);
                persistUnsent(sender, sessionId, projectId);
                mic = await openMicrophone();
                unsubscribe = subscribeRecording();
                await connection.open();
                connection.send({ type: 'resume', session: sessionId, nextSeq: sender.nextSeq });
                const reply = await connection.waitFor(
                    (m): m is StartedMessage | ErrorMessage =>
                        (m.type === 'started' && m.session === sessionId) || m.type === 'error',
                    10000,
                );
                if (reply.type === 'error') {
                    if (reply.code !== 'session_not_found') {
                        throw new Error(reply.message);
                    }
                    // 待つ時間を過ぎて途中で終わっていた。届かなかった音声を頭に足して、続きを録音する（#101）
                    leftover = { sessionId, pcm: sender.unsent() };
                    closeRecording();
                    unsentEntry = null;
                    set({ unsent: null });
                    starting = false;
                    await startOrContinue(projectId, sessionId);
                    return;
                }
                // 続く ack（サーバーが受け取り済みの最後の連番）を受けたら、溜めていた音声を送り直す
                resendAfterAck = true;
                // 経過時間は、続く ack を受けて受け取り済みの分を除いてから決める（二重に数えないように）
                recoveredBase = Math.round((reply.offsetSec ?? 0) * SAMPLE_RATE);
                recordedSamples = recoveredBase;
                unsentEntry = null;
                set((s) => ({
                    unsent: null,
                    projects: updateSession(s.projects, sessionId, (x) => ({ ...x, status: 'recording' })),
                    selection: { projectId, sessionId },
                    recordingState: 'recording',
                    recordingSessionId: sessionId,
                    elapsed: Math.floor(recordedSamples / SAMPLE_RATE),
                    partial: null,
                    liveDraft: null,
                }));
            } catch (e) {
                closeRecording();
                toast.error(`届いていない音声を送れません: ${(e as Error).message}`);
            } finally {
                starting = false;
                resuming = false;
            }
        },

        discardUnsent: async () => {
            const entry = unsentEntry;
            unsentEntry = null;
            set({ unsent: null });
            if (entry) {
                await clearSession(entry.session);
            }
        },

        rejectTerm: async (sessionId, term) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            const drop = (terms?: string[]) => terms?.filter((t) => t !== term);
            // 先に画面から消す（失敗したら戻す）
            const before = project.sessions.find((x) => x.id === sessionId)?.pickedTerms;
            set((s) => ({
                projects: updateSession(s.projects, sessionId, (x) => ({ ...x, pickedTerms: drop(x.pickedTerms) })),
            }));
            if (isDemo) {
                return;
            }
            try {
                const res = await api.delete<TermsJson>(
                    `/api/projects/${project.id}/sessions/${sessionId}/terms/${encodeURIComponent(term)}`,
                );
                set((s) => ({
                    projects: updateSession(s.projects, sessionId, (x) => ({ ...x, pickedTerms: res.pickedTerms })),
                }));
            } catch (e) {
                set((s) => ({
                    projects: updateSession(s.projects, sessionId, (x) => ({ ...x, pickedTerms: before })),
                }));
                toast.error(`用語を消せません: ${(e as Error).message}`);
            }
        },

        reopenMicrophone: async () => {
            if (get().recordingState === 'idle' || !mic) {
                return;
            }
            const state = get().micState;
            try {
                if (state === 'suspended') {
                    await mic.restart();
                    return;
                }
                // 止まったトラックは戻らないので、マイクを開き直す（送信と経過時間はそのまま続く）
                const next = await openMicrophone();
                mic.close();
                mic = next;
                toast.success('マイクを開き直しました。録音を続けています');
            } catch (e) {
                toast.error(`マイクを開き直せません: ${(e as Error).message}`);
            }
        },

        continueRecording: async (sessionId) => {
            const s = get();
            const project = s.projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project || s.recordingState !== 'idle' || starting) {
                return;
            }
            if (stoppedWhileOffline) {
                toast.warning(
                    '前の録音の残りをサーバーに送るのを待っています。サーバーにつながってから、もう一度押してください',
                );
                return;
            }
            await startOrContinue(project.id, sessionId);
        },

        // 一時停止の前までの音声を送り切ってから pause を送る
        pauseRecording: async () => {
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
        },

        // 録音を終えたら、セッションの終了日時と状態を確定して、最終の要約を作り始める
        stopRecording: async () => {
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
                transcriptionStalled: false,
                // 流れている途中で終えると summary.done（live）が来ないので、書きかけの途中の要約は捨てる
                liveDraft: null,
                projects: sessionId
                    ? // 長さはサーバーと同じ時計の経過時間。取り直すまでの間も、左メニューに秒まで出せるように
                      updateSession(s.projects, sessionId, (x) => ({
                          ...x,
                          status: 'done',
                          endedAt,
                          durationSec: s.elapsed,
                      }))
                    : s.projects,
                // 最終の要約はサーバーが作り、summary.delta（final）で届く。届くまでは「作成中」と出す
                generating: sessionId
                    ? { sessionId, model: s.settings.ollama.finalSummaryModel, text: '' }
                    : s.generating,
            }));
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
            // 前にページを開いていたときに、サーバーに届かなかった音声が残っていないか（#102）
            if (!isDemo) {
                void listUnsent().then((list) => {
                    const entry = list.find((e) => e.frames.length > 0);
                    if (!entry || get().recordingState !== 'idle') {
                        return;
                    }
                    unsentEntry = entry;
                    const samples = entry.frames.reduce((n, f) => n + (f.frame.byteLength - 4) / 2, 0);
                    set({
                        unsent: {
                            sessionId: entry.session,
                            projectId: entry.project,
                            seconds: Math.round(samples / SAMPLE_RATE),
                        },
                    });
                });
            }
            connection.onStateChange((connected) => {
                set((s) => ({
                    server: { ...s.server, connection: connected ? 'connected' : 'reconnecting' },
                    // 切れたら、届きかけの途中の要約は捨てる（つながり直した後の断片が続けて足されないように）
                    liveDraft: connected ? s.liveDraft : null,
                }));
                if (connected) {
                    // 最初に届く status で、切れている間に最終の要約ができていないかを確かめる（#118）
                    freshConnection = true;
                }
                if (connected && !isDemo) {
                    // 切れている間に届かなかった contextSet（作成の終わり）を取りこぼさないように、一覧を取り直す
                    void refreshContextSets(get().projects.map((p) => p.id));
                    void loadServerVersion();
                }
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
                    // recordings と queue は画面に出さない（GPU キューは jobs で出す）
                    const ollamaBack = m.ollama === 'ready' && get().server.ollama !== 'ready';
                    // status は GPU の使用率が変わるたびにも届くが、jobs の秒数はキューが変わったときのまま。
                    // jobs が変わったときだけ受け取った時刻を記録し直す（経過時間が戻らないように）
                    const jobsChanged = !!m.jobs && JSON.stringify(m.jobs) !== JSON.stringify(get().server.jobs);
                    set((s) => ({
                        server: {
                            ...s.server,
                            whisper: m.whisper,
                            ollama: m.ollama,
                            jobs: jobsChanged && m.jobs ? m.jobs : s.server.jobs,
                            jobsAt: jobsChanged ? Date.now() : s.server.jobsAt,
                            gpu: m.gpu ?? null,
                        },
                    }));
                    // Ollama につながるようになったら、モデルの一覧を取り直す（つながらない間は空になっている）
                    if (ollamaBack) {
                        void get().loadOptions();
                    }
                    // 録音中のセッションの数が変わったら（ほかの端末で始めた・終えたなど）、一覧を取り直す
                    if (m.recordings !== lastRecordings) {
                        lastRecordings = m.recordings;
                        void get().loadProjects();
                    }
                    // 古いサーバーは summarizing を送らない（そのときは title と error だけで消す）
                    if (m.summarizing && !isDemo) {
                        receiveSummarizing(m.summarizing);
                    }
                } else if (m.type === 'summary.delta' && m.kind === 'final') {
                    // 最終の要約（録音を終えた後と、作り直し）。少しずつ届く
                    set((s) => ({
                        generating: {
                            sessionId: m.session,
                            model:
                                s.generating?.sessionId === m.session
                                    ? s.generating.model
                                    : s.settings.ollama.finalSummaryModel,
                            text: (s.generating?.sessionId === m.session ? s.generating.text : '') + m.text,
                        },
                    }));
                } else if (m.type === 'finalTranscript' && !isDemo) {
                    // 最終の文字起こしができた（#121）。最終の要約を待っている間（一覧の取り直しでは中身を
                    // 置き換えない）でも出せるように、そのセッションの最終の文字起こしだけを取ってきて足す
                    void receiveFinalTranscript(m.session);
                } else if (m.type === 'title') {
                    set((s) => ({
                        projects: updateSession(s.projects, m.session, (x) => ({
                            ...x,
                            title: m.title,
                            provisionalTitle: m.provisional,
                        })),
                    }));
                    // 最終のタイトルは、最終の要約を保存した後に届く。保存されたものを取り直して表示を置き換える
                    if (!m.provisional) {
                        void reloadAfterFinalSummary(m.session);
                    }
                }
                if (
                    m.type === 'error' &&
                    m.session &&
                    (m.code === 'ollama_unavailable' ||
                        m.code === 'summary_skipped' ||
                        m.code === 'summary_failed' ||
                        m.code === 'write_failed')
                ) {
                    // 要約を作れなかった（作らなかった）。作成中の表示を消す。
                    // Ollama の失敗なら、途中の要約の下書きも捨てる（届きかけの分が、次の回の要約に混ざらないように。
                    // 音声の write_failed では捨てない）
                    set((s) => ({
                        generating: s.generating?.sessionId === m.session ? null : s.generating,
                        liveDraft:
                            m.code === 'ollama_unavailable' && s.liveDraft?.sessionId === m.session
                                ? null
                                : s.liveDraft,
                    }));
                    // 最終の要約の失敗はサーバーが記録している（spec 6.7）。手元で決めつけず、取り直して記録に合わせる
                    // （録音を終えた直後の途中の要約や音声の失敗を、要約の失敗と取り違えないように）
                    if (get().recordingSessionId !== m.session) {
                        void get().loadProjects();
                    }
                }
                // project のない contextSet（モックの /api/mock/context-set のまね）は、どのプロジェクトか分からないので無視する
                if (m.type === 'contextSet' && m.project) {
                    // 参考資料セットの作成の進み具合（ほかの端末で始めたものも）
                    const pid = m.project;
                    const known = (get().contextSets[pid] ?? []).find((x) => x.id === m.id);
                    if (!known) {
                        // 知らないセット（ほかの端末で始めたもの）は、一覧ごと取り直す
                        void refreshContextSets([pid]);
                        return;
                    }
                    set((s) => ({
                        contextSets: {
                            ...s.contextSets,
                            [pid]: (s.contextSets[pid] ?? []).map((x) =>
                                x.id === m.id ? { ...x, status: m.status } : x,
                            ),
                        },
                    }));
                    if (known.status === 'generating' && m.status === 'ready') {
                        toast.success('参考資料セットができました');
                    } else if (known.status === 'generating' && m.status === 'failed') {
                        toast.error('参考資料セットを作れませんでした（資料を読めないか、Ollama に接続できません）');
                    }
                }
                if (m.type === 'error' && !starting && !resuming) {
                    // 録音を始める・続けるときのエラーは、それぞれの処理でまとめて出す
                    toast.error(m.message);
                }
            });
            connection.start();
        },

        // 簡易設定・設定モーダルのどちらからでも呼ぶ。全体設定を保存する（PATCH /api/settings）。保存できたら true
        changeSettings: async (next) => {
            if (isDemo) {
                set({ settings: next });
                return true;
            }
            const before = get().settings.ollama.finalSummaryModel;
            try {
                set({ settings: await api.patch<Settings>('/api/settings', next) });
                // 最終の要約のモデルを変えたら、開いているセッションにそのモデルの要約がなければ作り直す（spec 6.5）
                const model = get().settings.ollama.finalSummaryModel;
                const session = currentSession(get());
                if (model !== before && session && needsSummaryFor(session, model) && !get().generating) {
                    void get().regenerateSummary(session.id);
                }
                return true;
            } catch (e) {
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中は設定を変えられません（ほかの端末で録音しているかもしれません）');
                } else {
                    toast.error(`設定を保存できません: ${(e as Error).message}`);
                }
                return false;
            }
        },

        regenerateSummary: async (sessionId) => {
            if (isDemo) {
                toast.info('デモでは要約を作り直せません');
                return;
            }
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            finishedSummaries.delete(sessionId);
            try {
                const { model } = await api.post<{ model: string }>(
                    `/api/projects/${project.id}/sessions/${sessionId}/summaries`,
                );
                if (finishedSummaries.has(sessionId)) {
                    // 返事より先に作り終えていた（「作成中」にすると、消すきっかけがもう来ない）
                    void reloadAfterFinalSummary(sessionId);
                    return;
                }
                // 結果は WebSocket（summary.delta）で届く。届くまでは「作成中」と出す。
                // 返事より先に届いた分があれば残す
                set((s) => ({
                    generating: {
                        sessionId,
                        model,
                        text: s.generating?.sessionId === sessionId ? s.generating.text : '',
                    },
                }));
            } catch (e) {
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中か、録音を終えた直後のセッションです。少し待ってから作り直してください');
                } else if (e instanceof ApiError && e.status === 410) {
                    toast.error('文字起こしが保存期間を過ぎて消えているため、要約を作り直せません');
                } else {
                    toast.error(`要約を作り直せません: ${(e as Error).message}`);
                }
            }
        },

        // 使うセットと、用語リスト・コンテキストを使うかを保存する（PATCH .../selection）。録音中は 409
        changeContextSelection: async (next) => {
            const project = currentProject(get());
            if (!project) {
                return;
            }
            // 保存するまでの間だけ、手元の選択（contextSelections）で上書きして出す
            const pid = project.id;
            const clearOverride = (s: AppState) => {
                const selections = { ...s.contextSelections };
                delete selections[pid];
                return selections;
            };
            set((s) => ({ contextSelections: { ...s.contextSelections, [pid]: next } }));
            if (isDemo) {
                return;
            }
            try {
                const saved = await api.patch<ProjectJson['selection']>(`/api/projects/${pid}/selection`, {
                    contextSet: next.setId,
                    useHotwords: next.useHotwords,
                    useContext: next.useContext,
                    pickTerms: next.pickTerms,
                });
                // 保存できたら、サーバーの選択（project.selection）を正にして、手元の上書きは消す
                // （ほかの端末で変えた選択も、取り直しで出るように）
                set((s) => ({
                    projects: s.projects.map((p) => (p.id === pid ? { ...p, selection: toSelection(saved) } : p)),
                    contextSelections: clearOverride(s),
                }));
            } catch (e) {
                // 保存できなければ、上書きを消して元（サーバーの選択）に戻す
                set((s) => ({ contextSelections: clearOverride(s) }));
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中は参考資料を変えられません（ほかの端末で録音しているかもしれません）');
                } else {
                    toast.error(`参考資料の選択を保存できません: ${(e as Error).message}`);
                }
            }
        },

        // 資料を送ってセットの作成を始める（POST .../context-sets）。できたかは contextSet で届く。
        // 同じ資料の組み合わせのセットがあれば、サーバーが使い回す（spec 6.6 節）
        createContextSet: async (materials) => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                return;
            }
            const pid = project.id;
            const selection = currentContextSelection(s);
            if (!isDemo) {
                try {
                    const created = await api.post<ContextSet & { reused: boolean }>(
                        `/api/projects/${pid}/context-sets`,
                        { materials },
                    );
                    const entry: ContextSet = { id: created.id, status: created.status, materials: created.materials };
                    set((st) => {
                        const list = (st.contextSets[pid] ?? []).filter((x) => x.id !== entry.id);
                        // 一覧は ID の昇順（サーバーと同じ）
                        const sorted = [...list, entry].sort((a, b) => a.id.localeCompare(b.id));
                        return { contextSets: { ...st.contextSets, [pid]: sorted } };
                    });
                    if (created.reused) {
                        toast.info('同じ資料で作ったセットがあるので、それを使います');
                    }
                    await get().changeContextSelection({ ...selection, setId: created.id });
                } catch (e) {
                    toast.error(`参考資料セットを作れません: ${(e as Error).message}`);
                }
                return;
            }
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

// マイクが止まったときの知らせ（#102）
// 音は届いているのに文字起こしが出ないとき（#120）。録音は続いている（音声はサーバーに保存されている）
export const stalledMessage =
    '音は届いていますが、しばらく文字起こしが出ていません。録音は続いています。マイクの処理（設定の「ブラウザのエコー除去」「ブラウザの雑音抑制」）を切ると直ることがあります';

export function micStateMessage(state: MicState) {
    switch (state) {
        case 'ended':
            return 'マイクが止まりました。録音されていません。「マイクを開き直す」を押してください';
        case 'muted':
            return 'マイクの音が届いていません（ほかのアプリや OS がマイクを止めています）。録音されていません';
        case 'suspended':
            return '音声の処理が止まりました（電話や通知などのため）。「マイクを開き直す」を押してください';
        default:
            return '';
    }
}

// 録音中（一時停止中も）は、画面がスリープしないようにする（#102）
useAppStore.subscribe((s, prev) => {
    if (s.recordingSessionId !== prev.recordingSessionId) {
        keepScreenOn(s.recordingSessionId !== null);
    }
});

// 開発中は、ブラウザの開発者ツールや Playwright からストアと接続を見られるようにする
// （接続は、切れたときの動きを確かめるため）
if (import.meta.env.DEV) {
    Object.assign(window, {
        appStore: useAppStore,
        appConnection: connection,
        // マイクが止まったとき・画面のスリープを止めているかを確かめるため（#102）
        appMicrophone: () => mic,
        appScreenKeptOn: screenKeptOn,
    });
}
