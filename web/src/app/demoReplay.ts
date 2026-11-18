// デモ版のリプレイ（#416）の入口。リプレイのセッション（一覧では録音中の形）を開いたら最初から再生し、
// 最後まで行ったら終わった状態のまま止める。ほかを開いたら止めて、録音中の形に戻す（もう一度開いたら最初から）。
// 入口は仮決め（匠の確認待ち）なので、いつ始めて・いつ止めるかはこのファイルだけで決める。
//
// 再生は、記録したサーバーからのメッセージを、WebSocket で届いたときと同じ道（connection.receive）に流す。
// 記録は録音した端末のものなので、見ている端末にサーバーが送るもの（watching・recordingState）を足して、
// 「ほかの端末で録音中のセッションを見る」（#238）のと同じ受け取り方にする
import { connection } from '@/api/connection';
import { type ReplayTarget, type ReplayView, watchStoppedAt } from '@/api/demoReplayView';
import type { DemoReplay } from '@/api/demoTypes';
import type { ServerMessage } from '@/api/protocol';
import type { AppState, AppStore } from '@/app/appState';
import { queryClient, queryKeys } from '@/app/query';
import { setLoaded } from '@/app/sessionData';
import { ReplayPlayer, type TimedMessage } from '@/features/replay/replayPlayer';

export type ReplaySource = {
    target: ReplayTarget;
    view: ReplayView;
    load: () => Promise<DemoReplay> | null;
};

// デモ版で、録音中のセッション（リプレイ）の見出しに出す説明（「ほかの端末で録音中」の代わり）
export const REPLAY_NOTE = '録音したときの様子を再生しています';

// 再生をやめたときに流す、何もしていないサーバーの状態（GPU のジョブの表示を消す）
const IDLE_STATUS: ServerMessage = {
    type: 'status',
    whisper: 'unloaded',
    ollama: 'ready',
    recordings: 0,
    queue: 0,
    jobs: { running: null, waiting: [] },
    summarizing: [],
    transcribing: [],
};

// 記録に、録音を終えたときに見ている端末へ届く recordingState を足したもの（時刻の順）。
// stop の後に届いた最後の区間の final の、すぐ後に入れる（サーバーと同じ順。watchStoppedAt）
export function replayTimeline(record: DemoReplay, sessionId: string): TimedMessage<ServerMessage>[] {
    const messages = record.messages as TimedMessage<ServerMessage>[];
    const stoppedAt = watchStoppedAt(record);
    const at = messages.findIndex((m) => m.t > stoppedAt);
    const stopped = {
        t: stoppedAt,
        msg: { type: 'recordingState', session: sessionId, state: 'stopped' } as ServerMessage,
    };
    const split = at === -1 ? messages.length : at;
    return [...messages.slice(0, split), stopped, ...messages.slice(split)];
}

export class DemoReplayEntry {
    private readonly store: AppStore;
    private readonly source: ReplaySource;
    private readonly player: ReplayPlayer<ServerMessage>;
    private timeline: TimedMessage<ServerMessage>[] | null = null;
    // リプレイのセッションを開いているか
    private open = false;
    // 開くたびに増やす。記録を読んでいる間に閉じた・開き直したら、古いほうは始めない
    private run = 0;

    constructor(store: AppStore, source: ReplaySource) {
        this.store = store;
        this.source = source;
        this.player = new ReplayPlayer(
            (msg, t) => {
                this.source.view.seek(t);
                connection.receive(msg);
            },
            () => this.source.view.seek(Infinity),
        );
    }

    // 開いているセッションを見張る。今リプレイのセッションを開いていれば、すぐ始める
    attach() {
        this.store.subscribe((s, prev) => {
            if (s.selection !== prev.selection) {
                this.selectionChanged(s.selection);
            }
        });
        this.selectionChanged(this.store.getState().selection);
    }

    private isTarget(selection: AppState['selection']) {
        const { projectId, sessionId } = this.source.target;
        return selection.projectId === projectId && selection.sessionId === sessionId;
    }

    private selectionChanged(selection: AppState['selection']) {
        const target = this.isTarget(selection);
        if (target && !this.open) {
            void this.begin();
        } else if (!target && this.open) {
            this.end();
        }
    }

    // 最初から再生する。画面に残っている前の回の中身は捨て、録音中の形の一覧と中身を取り直してから始める
    private async begin() {
        this.open = true;
        const run = ++this.run;
        this.player.stop();
        this.source.view.seek(0);
        this.forgetSession();
        const timeline = await this.loadTimeline();
        if (run !== this.run || !timeline) {
            return;
        }
        await this.store.getState().loadProjects();
        if (run !== this.run) {
            return;
        }
        const { sessionId } = this.source.target;
        connection.receive({ type: 'watching', session: sessionId, state: 'recording', transcript: [] });
        this.player.play(timeline);
    }

    // 途中で閉じた（最後まで行った後に閉じたときも）。止めて、見ている状態・作成中の要約・GPU の表示を消し、
    // 一覧を録音中の形に戻す
    private end() {
        this.open = false;
        this.run += 1;
        this.player.stop();
        this.source.view.seek(0);
        const { sessionId } = this.source.target;
        if (this.store.getState().watching?.sessionId === sessionId) {
            connection.receive({ type: 'recordingState', session: sessionId, state: 'stopped' });
        }
        connection.receive(IDLE_STATUS);
        this.store.setState((s) => ({ generating: s.generating?.sessionId === sessionId ? null : s.generating }));
        this.forgetSession();
        void this.store.getState().loadProjects();
    }

    private async loadTimeline() {
        if (!this.timeline) {
            const record = await this.source.load();
            if (!record) {
                return null;
            }
            this.source.view.setRecord(record);
            this.timeline = replayTimeline(record, this.source.target.sessionId);
        }
        return this.timeline;
    }

    // セッションの中身のキャッシュを捨てて、次に開いたときに取り直すようにする
    private forgetSession() {
        const { projectId, sessionId } = this.source.target;
        queryClient.removeQueries({ queryKey: [...queryKeys.sessions(projectId), sessionId] });
        setLoaded(this.store, sessionId, null);
    }
}
