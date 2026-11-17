// サーバーにつなぎ続け、状態（status）とメッセージを受け取る（spec/api.md 7.2）。
// 接続が切れているかどうかは status に含まれないので、ブラウザ側で判定する
import { api } from '@/api/api';
import { connection } from '@/api/connection';
import { isDemo } from '@/api/demo';
import { isCloud } from '@/api/endpoint';
import type { ServerMessage } from '@/api/protocol';
import { queryClient } from '@/app/query';
import { type MessageContext, receiveServerMessage } from '@/app/serverMessages';
import type { StatusReceiver } from '@/app/serverStatus';
import { readProjectInfos } from '@/app/sessionData';
import type { VersionJson } from '@/app/version';
import { refreshContextSets } from '@/features/materials/contextSetCache';
import { recordingConnectionChanged } from '@/features/recording/reconnect';
import { loadUnsent } from '@/features/recording/unsentRecovery';
import type { Watcher } from '@/features/recording/watcher';

export type ServerContext = MessageContext & { watcher: Watcher; status: StatusReceiver };

// サーバーのバージョンを取る（起動したときと、つながり直したとき。サーバーが入れ替わっているかもしれないため）
export async function loadServerVersion(store: ServerContext['store']) {
    if (isDemo) {
        return;
    }
    try {
        store.setState({ serverVersion: (await api.get<VersionJson>('/api/version')).version });
    } catch {
        // 取れなければ前の値のまま
    }
}

function connectionChanged(ctx: ServerContext, connected: boolean) {
    const { store, recorder } = ctx;
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
        void refreshContextSets(readProjectInfos().map((p) => p.id));
        void loadServerVersion(store);
    }
    // 録音中に切れていたら、続きから録音する
    recordingConnectionChanged(recorder, connected);
}

function receive(ctx: ServerContext, m: ServerMessage) {
    ctx.watcher.receive(m);
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
        // 開いているセッションがほかのクライアントで録音中なら見る（#238）。一覧はキャッシュにあるので、両方を見る
        store.subscribe(() => ctx.watcher.sync());
        queryClient.getQueryCache().subscribe(() => ctx.watcher.sync());
    }
    connection.onStateChange((connected) => connectionChanged(ctx, connected));
    connection.subscribe((m) => receive(ctx, m));
    connection.start();
}
