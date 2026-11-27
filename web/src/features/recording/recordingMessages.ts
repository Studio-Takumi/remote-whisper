// 録音のためのメッセージ（ack・partial・final・途中の要約）を受け取る（spec/api.md 7.2）
import { toast } from 'sonner';

import { connection } from '@/api/connection';
import type { AppStore } from '@/app/appState';
import { patchSessionData } from '@/app/sessionData';
import { findLocal, patchLocal } from '@/features/projects/localSessions';
import { SAMPLE_RATE } from '@/features/recording/audio/microphone';
import { stalledMessage } from '@/features/recording/micMessages';
import type { Recorder } from '@/features/recording/recorderState';
import { type LiveMessage, applyLiveMessage, isLiveMessage } from '@/features/session/liveMessages';

// 録音中・見ている録音の行・語・途中の要約を入れる。手元のセッションはストアに、それ以外はキャッシュに入れる（#361）
export function applyLive(store: AppStore, m: LiveMessage) {
    const s = store.getState();
    const change = applyLiveMessage(s, m);
    if (!change) {
        return;
    }
    const { session, ...rest } = change;
    const local = !!session && !!findLocal(s.localSessions, m.session);
    if (session && !local) {
        patchSessionData(store, m.session, session);
    }
    // 手元のセッションでなければ localSessions は作り直さない（一覧を描き直さないように）
    store.setState((st) => ({
        ...rest,
        ...(local && session && { localSessions: patchLocal(st.localSessions, m.session, session) }),
    }));
}

// 録音の購読で受け取るもの。途中の要約は録音中のセッションだけ（終えた後に届いたものは出さない）。
// 行・語は最後の final を受けるため録音を終えた後も受け取るが、見ているセッションのものは watch に任せる
function isMyRecording(r: Recorder, m: LiveMessage) {
    const s = r.store.getState();
    if (m.type === 'summary.delta' || m.type === 'summary.done') {
        return m.session === s.recordingSessionId;
    }
    return m.session === s.recordingSessionId || m.session !== s.watching?.sessionId;
}

// つなぎ直した直後の ack は、サーバーが受け取り済みの最後の連番。その次から送り直す
function resendAfterAck(r: Recorder) {
    r.resendAfterAck = false;
    // ページを読み込み直した後なら、サーバーが受け取り済みの分を ack で除いてから経過時間を戻す
    if (r.recoveredBase !== null && r.sender) {
        r.recordedSamples = r.recoveredBase + r.sender.unsentSamples;
        r.recoveredBase = null;
        r.store.setState({ elapsed: Math.floor(r.recordedSamples / SAMPLE_RATE) });
    }
    r.sender?.resend();
    // 溜めた音声を送り終えてから、切れている間の操作を今の状態に合わせて伝える
    if (r.stoppedWhileOffline) {
        // 切れている間に録音を終えていた
        r.stoppedWhileOffline = null;
        connection.send({ type: 'stop' });
    } else {
        // 切れている間の一時停止・再開は届いていないので、必ず今の状態を送る
        connection.send({ type: r.store.getState().recordingState === 'paused' ? 'pause' : 'unpause' });
    }
}

// 接続した直後に届く status も受け取れるように、つなぐ前に呼ぶ。
// 最終の要約・タイトル・要約の失敗は、作り直しでも届くので、常時の購読（serverMessages）で受け取る
export function subscribeRecording(r: Recorder) {
    return connection.subscribe((m) => {
        r.metrics.receive(m);
        if (m.type === 'ack') {
            r.sender?.ack(m.seq);
            if (r.resendAfterAck) {
                resendAfterAck(r);
            }
        } else if (m.type === 'transcriptionStalled') {
            if (m.stalled && !r.store.getState().transcriptionStalled) {
                toast.warning(stalledMessage(), { duration: 15000 });
            }
            r.store.setState({ transcriptionStalled: m.stalled });
        } else if (isLiveMessage(m) && isMyRecording(r, m)) {
            applyLive(r.store, m);
        }
    });
}
