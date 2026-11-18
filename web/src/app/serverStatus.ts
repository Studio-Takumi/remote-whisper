// サーバー全体の状態（status。spec/api.md 7.2）を受け取る。Whisper・LLM・GPU の状態を画面に出し、
// 録音中のセッションの数・最終の要約を作っているセッションが変わったら取り直す（#118）
import { usesMockData } from '@/api/demo';
import type { ServerMessage } from '@/api/protocol';
import type { AppState, AppStore } from '@/app/appState';
import { type Recorder, offlineStoppedSession } from '@/features/recording/recorderState';

type StatusMessage = Extract<ServerMessage, { type: 'status' }>;

// 同じ中身なら前の配列のまま（描き直さないように）
function sameOr(next: string[] | undefined, before: string[]) {
    return JSON.stringify(next ?? []) === JSON.stringify(before) ? before : (next ?? []);
}

// status を画面に出す形にする（spec/api.md 7.2）。status は GPU の使用率でも届くので、
// jobs が変わったときだけ受け取った時刻を記録し直す（経過時間が戻らないように。spec/api.md 7.2）
function serverFrom(server: AppState['server'], m: StatusMessage): AppState['server'] {
    const jobsChanged = !!m.jobs && JSON.stringify(m.jobs) !== JSON.stringify(server.jobs);
    return {
        ...server,
        whisper: m.whisper,
        ollama: m.ollama,
        lmstudio: m.lmstudio,
        jobs: jobsChanged && m.jobs ? m.jobs : server.jobs,
        jobsAt: jobsChanged ? Date.now() : server.jobsAt,
        gpu: m.gpu ?? null,
        transcribing: sameOr(m.transcribing, server.transcribing),
        summarizing: sameOr(m.summarizing, server.summarizing),
    };
}

export class StatusReceiver {
    // サーバー全体で録音中のセッションの数。変わったら一覧を取り直す（ほかの端末の録音を出すため）
    private lastRecordings = -1;
    // サーバーが最終の要約を作っているセッション（直近の summarizing。古いサーバーでは null）
    private summarizing: Set<string> | null = null;
    // つながってから、まだ status を受け取っていない。つながり直した直後の status には、
    // 切れている間に作り終えたことが含まれる（title を取りこぼしていても、ここで気づける）
    private fresh = false;
    // summarizing から外れた（作り終えた）セッション。作り直しの返事より先に作り終えたときに使う
    private readonly finishedSummaries = new Set<string>();

    private readonly store: AppStore;
    private readonly recorder: Recorder;
    private readonly reloadAfterFinalSummary: (sessionId: string) => Promise<void>;

    constructor(store: AppStore, recorder: Recorder, reloadAfterFinalSummary: (sessionId: string) => Promise<void>) {
        this.store = store;
        this.recorder = recorder;
        this.reloadAfterFinalSummary = reloadAfterFinalSummary;
    }

    // 最終の要約の作り直しを頼む。前に作り終えた記録は消し、返事を待つ間に作り終えたかを見られるようにする
    forgetFinishedSummary(sessionId: string) {
        this.finishedSummaries.delete(sessionId);
    }

    // 作り直しを頼んでから、もう作り終えていたか
    summaryFinished(sessionId: string) {
        return this.finishedSummaries.has(sessionId);
    }

    // つながった。最初に届く status で、切れている間に最終の要約ができていないかを確かめる
    connected() {
        this.fresh = true;
    }

    receive(m: StatusMessage) {
        const { getState: get, setState: set } = this.store;
        // LLM（Ollama か LM Studio。#327）につながるようになったら、モデルの一覧を取り直す（つながらない間は空）
        const llmBack =
            (m.ollama === 'ready' && get().server.ollama !== 'ready') ||
            (m.lmstudio === 'ready' && get().server.lmstudio !== 'ready');
        set((s) => ({ server: serverFrom(s.server, m) }));
        if (llmBack) {
            void get().loadOptions();
        }
        if (m.recordings !== this.lastRecordings) {
            this.lastRecordings = m.recordings;
            void get().loadProjects();
        }
        // 古いサーバーは summarizing を送らない（そのときは title と error だけで消す）。
        // 同梱したデータのデモ版（リプレイ #416）は、サーバーと同じく取り直せる
        if (m.summarizing && !usesMockData) {
            this.receiveSummarizing(m.summarizing);
        }
    }

    // 「作成中」のセッションの要約をサーバーが作り終えていたら、保存されたものを取り直して「作成中」を消す
    // （結果のメッセージを取りこぼしても残らないように）
    private receiveSummarizing(list: string[]) {
        const before = this.summarizing;
        const fresh = this.fresh;
        const now = new Set(list);
        this.summarizing = now;
        this.fresh = false;
        for (const id of before ?? []) {
            if (!now.has(id)) {
                this.finishedSummaries.add(id);
            }
        }
        for (const id of now) {
            this.finishedSummaries.delete(id);
        }
        const s = this.store.getState();
        const id = s.generating?.sessionId;
        // 作っている途中か、まだ始まっていない（録音中・切れている間に止めて、stop をまだ送っていない）
        if (!id || now.has(id) || id === s.recordingSessionId || id === offlineStoppedSession(this.recorder)) {
            return;
        }
        // 作っていたのに外れた・つながり直したらもう作っていなかった。
        // （止めた直後に、止める前の status が遅れて届いたときは、どちらでもないので何もしない）
        if (before?.has(id) || fresh) {
            void this.reloadAfterFinalSummary(id);
        }
    }
}
