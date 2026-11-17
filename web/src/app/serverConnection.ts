// サーバーにつなぎ続け、状態（status）とメッセージを受け取る（spec/api.md 7.2）。
// 接続が切れているかどうかは status に含まれないので、ブラウザ側で判定する
import { connection } from '@/api/connection';
import { isDemo } from '@/api/data';
import { isCloud } from '@/api/endpoint';
import type { ServerMessage } from '@/api/protocol';
import { type MessageContext, receiveServerMessage } from '@/app/serverMessages';
import type { StatusReceiver } from '@/app/serverStatus';
import { recordingConnectionChanged } from '@/features/recording/reconnect';
import { loadUnsent } from '@/features/recording/unsentRecovery';
import type { Watcher } from '@/features/recording/watcher';

// セッションの中身を変える通知（受け取ったら、キャッシュにも入れる）。
// title・finalTranscript・corrections・sessionMoved などは、それぞれの処理でキャッシュを書き換える・取り直す
const SESSION_MESSAGES = new Set<ServerMessage['type']>(['final', 'terms', 'summary.done', 'watching']);

export type ServerContext = MessageContext & {
    watcher: Watcher;
    status: StatusReceiver;
    // サーバーのバージョンを取り直す（つながり直したとき。サーバーが入れ替わっているかもしれないため）
    loadServerVersion: () => Promise<void>;
};

function connectionChanged(ctx: ServerContext, connected: boolean) {
    const { store, recorder, sessions } = ctx;
    store.setState((s) => ({
        server: { ...s.server, connection: connected ? 'connected' : 'reconnecting' },
        // 切れたら、届きかけの途中の要約は捨てる（つながり直した後の断片が続けて足されないように）
        liveDraft: connected ? s.liveDraft : null,
    }));
    if (connected) {
        ctx.status.connected();
    }
    if (connected && !isDemo) {
        // 切れている間に届かなかった contextSet（作成の終わり）を取りこぼさないように、一覧を取り直す
        void sessions.refreshContextSets(store.getState().projects.map((p) => p.id));
        void ctx.loadServerVersion();
    }
    // 録音中に切れていたら、続きから録音する
    recordingConnectionChanged(recorder, connected);
}

function receive(ctx: ServerContext, m: ServerMessage) {
    ctx.watcher.receive(m);
    // セッションの中身を変える通知（録音中・見ている録音の行・語・途中の要約）は、受け取った
    // ほかのリスナー（録音の購読）がストアを書き換えたあとで、キャッシュにも入れる
    if (SESSION_MESSAGES.has(m.type) && 'session' in m && m.session) {
        const sessionId = m.session;
        queueMicrotask(() => ctx.sessions.syncSessionToCache(sessionId));
    }
    if (m.type === 'status') {
        ctx.status.receive(m);
    }
    receiveServerMessage(ctx, m);
}

export function connectServer(ctx: ServerContext) {
    const { store, recorder } = ctx;
    // ページを閉じるときは、その時点までの録音ごとの数字を送る（#206。同じ録音を 2 回送らない）
    if (isCloud && !isDemo) {
        window.addEventListener('pagehide', () => {
            const s = store.getState();
            recorder.metrics.sendAll(!!s.recordingSessionId, s.elapsed);
        });
    }
    if (!isDemo) {
        // 前にページを開いていたときに、サーバーに届かなかった音声が残っていないか（#102）
        void loadUnsent(recorder);
        // 開いているセッションがほかのクライアントで録音中なら見る（#238）
        store.subscribe(() => ctx.watcher.sync());
    }
    connection.onStateChange((connected) => connectionChanged(ctx, connected));
    connection.subscribe((m) => receive(ctx, m));
    connection.start();
}
