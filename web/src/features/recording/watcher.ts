// ほかのクライアントで録音中のセッションを見る（#238。spec/api.md 7.2・spec/ui.md 8 章）と、
// そのセッションにこの端末のマイクを音源として参加する（#356）
import { toast } from 'sonner';

import { connection } from '@/api/connection';
import type { ServerMessage, WatchedState } from '@/api/protocol';
import type { AppStore } from '@/app/appState';
import { updateSession } from '@/features/projects/updateSession';
import { SourceJoin, forgetJoin, recalledJoin } from '@/features/recording/join';
import { applyLive } from '@/features/recording/recordingMessages';
import { watchTarget } from '@/features/recording/watch';
import { isLiveMessage } from '@/features/session/liveMessages';
import type { LivePartial } from '@/features/session/livePartials';
import { newlyDisconnected, sourceTitle } from '@/features/session/sources';

type WatchingMessage = Extract<ServerMessage, { type: 'watching' }>;
type SourcesMessage = Extract<ServerMessage, { type: 'sources' }>;
type RecordingStateMessage = Extract<ServerMessage, { type: 'recordingState' }>;

function dropSession(partials: LivePartial[], sessionId: string) {
    return partials.filter((p) => p.sessionId !== sessionId);
}

export class Watcher {
    // この端末のマイクで、録音中のセッションに音源として参加しているもの（#356）
    private joiner: SourceJoin | null = null;
    // watch を送ったセッション。stopped を受けたら null に戻し、一覧がまだ録音中なら
    // （終えてすぐ同じセッションの続きを録音した、など）送り直す
    private watched: string | null = null;

    private readonly store: AppStore;
    // 録音を終えたセッションの音源の一覧を取り直す（#357）
    private readonly refreshTranscripts: (sessionId: string) => Promise<void>;

    constructor(store: AppStore, refreshTranscripts: (sessionId: string) => Promise<void>) {
        this.store = store;
        this.refreshTranscripts = refreshTranscripts;
    }

    async join(sessionId: string) {
        if (this.joiner || this.store.getState().recordingState !== 'idle') {
            return;
        }
        await this.startJoin(sessionId, null);
    }

    leave() {
        this.joiner?.leave();
    }

    // 開いているセッションがほかのクライアントで録音中なら見る。開くセッション・一覧・録音の状態・接続が
    // 変わるたびに呼ぶ。つながり直したら、サーバーは見ていたことを覚えていないので送り直す
    sync() {
        const s = this.store.getState();
        const connected = s.server.connection === 'connected';
        const target = connected ? watchTarget(s.projects, s.selection, s.recordingSessionId) : null;
        if (!connected) {
            this.watched = null;
        }
        if (target === this.watched) {
            return;
        }
        this.watched = target;
        if (target) {
            connection.send({ type: 'watch', session: target });
        } else if (connected) {
            connection.send({ type: 'unwatch' });
        }
        if (s.watching && s.watching.sessionId !== target) {
            this.store.setState({ watching: null });
        }
    }

    // 見ているセッションに届くもの。自分で録音しているセッションのもの（録音の購読で受け取る）は扱わない
    receive(m: ServerMessage) {
        if (m.type === 'watching') {
            this.receiveWatching(m);
            return;
        }
        if (m.type === 'sources') {
            this.receiveSources(m);
            return;
        }
        const s = this.store.getState();
        const w = s.watching;
        if (!w || !('session' in m) || m.session !== w.sessionId || m.session === s.recordingSessionId) {
            return;
        }
        if (m.type === 'recordingState') {
            this.receiveRecordingState(m);
        } else if (isLiveMessage(m)) {
            applyLive(this.store, m);
        }
    }

    // 録音中のセッションに音源として参加する（#356）。rejoin は読み込み直す前に参加していた音源
    private async startJoin(sessionId: string, rejoin: { source: number; nextSeq: number } | null) {
        const { getState: get, setState: set } = this.store;
        const { noiseSuppression, autoGainControl, echoCancellation = true } = get().settings.recording;
        const join = new SourceJoin(
            sessionId,
            (joined) => set({ joined }),
            (message) => {
                if (this.joiner === join) {
                    this.joiner = null;
                }
                if (message) {
                    toast.error(message);
                }
                // サーバーは抜けた接続の「見ている」登録を消すので、まだ録音中なら見直して送り直す
                this.watched = null;
                set((s) => ({ projects: [...s.projects], micLevel: 0 }));
            },
            // マイクの音量（マイクボタンの輪に出す。#357）。参加している間は録音していないので、録音のものと重ならない
            (level) => {
                if (get().micLevel !== level) {
                    set({ micLevel: level });
                }
            },
        );
        this.joiner = join;
        try {
            await join.start({ noiseSuppression, autoGainControl, echoCancellation }, rejoin);
        } catch (e) {
            this.joiner = null;
            forgetJoin(sessionId);
            set({ joined: null });
            toast.error((e as Error).message);
        }
    }

    private receiveWatching(m: WatchingMessage) {
        if (m.state === 'idle' || m.state === 'stopped') {
            this.store.setState((s) => ({ watching: s.watching?.sessionId === m.session ? null : s.watching }));
            return;
        }
        // そこまでの文字起こし・リアルタイム要約・タイトルで置き換え、続きはこのあとのメッセージで足す
        this.store.setState((s) => ({
            watching: { sessionId: m.session, state: m.state as WatchedState, join: m.join },
            projects: updateSession(s.projects, m.session, (x) => ({
                ...x,
                transcript: m.transcript ?? x.transcript,
                liveSummary: m.liveSummary ?? x.liveSummary,
                title: m.title || x.title,
                loaded: true,
            })),
            liveDraft: s.liveDraft?.sessionId === m.session ? null : s.liveDraft,
        }));
        // 読み込み直す前に参加していたら、同じ音源としてつなぎ直す（#356）
        const recalled = recalledJoin(m.session);
        if (recalled && !this.joiner && m.join !== undefined) {
            void this.startJoin(m.session, recalled);
        }
    }

    private receiveSources(m: SourcesMessage) {
        const { getState: get, setState: set } = this.store;
        // 録音している端末では、参加した端末が切れたら知らせる（録音は続いている。#357）
        if (m.session === get().recordingSessionId) {
            for (const lost of newlyDisconnected(get().liveSources[m.session], m.sources)) {
                toast.warning(`${sourceTitle(lost.id, lost.name)} との接続が切れました。録音は続いています`, {
                    duration: 10000,
                });
            }
        }
        // 参加できるか（上限に達した・空いた）が変わる（#356）。音源の一覧も覚える（#357）
        set((s) => ({
            watching: s.watching?.sessionId === m.session ? { ...s.watching, join: m.join } : s.watching,
            liveSources: { ...s.liveSources, [m.session]: m.sources },
        }));
    }

    private receiveRecordingState(m: RecordingStateMessage) {
        const { getState: get, setState: set } = this.store;
        if (m.state !== 'stopped') {
            set((s) => ({ watching: s.watching && { ...s.watching, state: m.state } }));
            return;
        }
        // 録音を終えた。最終の文字起こし・最終要約は、全員に届くもの（status の transcribing・
        // summarizing と title）で気づける。一覧を取り直して、録音中ではなくする。
        // サーバーは見ている登録を消したので、まだ録音中なら（すぐ続きを録音した）見直して送り直す
        this.watched = null;
        set((s) => ({ watching: null, partials: dropSession(s.partials, m.session), liveDraft: null }));
        // 音源が 2 つ以上なら、音源の一覧をフロントマターのもの（参加していた時間）に替える（#357）
        const multi = (get().liveSources[m.session]?.length ?? 0) >= 2;
        void get()
            .loadProjects()
            .then(() => (multi ? this.refreshTranscripts(m.session) : undefined));
    }
}
