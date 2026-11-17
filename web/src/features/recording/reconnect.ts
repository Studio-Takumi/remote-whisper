// 録音中に切れた接続がつながり直したら、resume を送って続きから録音する（spec/flows.md 6.7・spec/api.md 7.2）。
// 切れている間もマイクは止めず、音声は ack されるまで手元に溜めておく
import { toast } from 'sonner';

import { connection } from '@/api/connection';
import { patchLocal } from '@/features/projects/localSessions';
import { closeRecording } from '@/features/recording/recorder';
import type { ErrorMessage, Recorder, StartedMessage } from '@/features/recording/recorderState';
import { formatDateTime } from '@/lib/time';

// 接続が切れた・つながった。録音中（または切れている間に録音を終えた）なら、溜める・resume する
export function recordingConnectionChanged(r: Recorder, connected: boolean) {
    if (!r.store.getState().recordingSessionId && !r.stoppedWhileOffline) {
        return;
    }
    r.metrics.connection(connected);
    if (connected) {
        void resumeAfterReconnect(r);
    } else {
        // 新しい接続ではセッションが resume されるまで音声を受け付けないので、それまで溜めておく
        r.sender?.hold();
        // 前の接続で待っていた resume は打ち切る
        r.resumeGeneration += 1;
        r.resuming = false;
        r.resendAfterAck = false;
    }
}

async function resumeAfterReconnect(r: Recorder) {
    const sessionId = r.store.getState().recordingSessionId ?? r.stoppedWhileOffline;
    if (!sessionId || !r.sender) {
        return;
    }
    const generation = ++r.resumeGeneration;
    r.resuming = true;
    r.resendAfterAck = false;
    try {
        connection.send({ type: 'resume', session: sessionId, nextSeq: r.sender.nextSeq });
        const reply = await connection.waitFor(
            (m): m is StartedMessage | ErrorMessage =>
                (m.type === 'started' && m.session === sessionId) || m.type === 'error',
        );
        // 待っている間に切れた（またはつなぎ直した）なら、この結果は使わない
        if (generation === r.resumeGeneration) {
            receiveResumed(r, sessionId, reply);
        }
    } catch {
        // 応答がない（切れたなら、つながり直したときにもう一度試す）
        if (generation === r.resumeGeneration) {
            retryResume();
        }
    } finally {
        if (generation === r.resumeGeneration) {
            r.resuming = false;
        }
    }
}

function receiveResumed(r: Recorder, sessionId: string, reply: StartedMessage | ErrorMessage) {
    if (reply.type === 'started') {
        // 続く ack（サーバーが受け取り済みの最後の連番）を受けたら、その次から送り直す
        r.resendAfterAck = true;
    } else if (reply.code === 'session_not_found') {
        // サーバーが待てる時間（recording.resumeTimeoutMin）を過ぎた、サーバーが再起動したなど
        interruptRecording(r, sessionId);
    } else {
        retryResume();
    }
}

// resume がうまくいかなかったら、接続を切ってつなぎ直す。つながったら、もう一度 resume する
// 同じ接続でやり直さないのは、遅れて届いた started で、サーバーがこの接続にセッションを付けているかもしれないため
function retryResume() {
    connection.drop();
}

// 録音が途中で終わったことにする（resume できなかったとき）
function interruptRecording(r: Recorder, sessionId: string) {
    const { getState: get, setState: set } = r.store;
    r.resendAfterAck = false;
    r.stoppedWhileOffline = null;
    // 途中で終わった録音は最終の要約が来ないので、ここまでの数字をすぐ送る（#206）
    r.metrics.interrupt(sessionId, get().elapsed);
    // 切れている間に録音してサーバーに届かなかった音声は、続きを録音するときに頭に足す（#101）
    if (r.sender) {
        r.leftover = { sessionId, pcm: r.sender.unsent() };
    }
    closeRecording(r);
    set((s) => ({
        recordingState: 'idle',
        recordingSessionId: null,
        micLevel: 0,
        transcriptionStalled: false,
        pendingAudio: 0,
        partials: [],
        liveDraft: null,
        localSessions: patchLocal(s.localSessions, sessionId, (x) => ({
            ...x,
            status: 'interrupted',
            endedAt: formatDateTime(),
        })),
    }));
    // 同じセッションのまま続きを録音できる（#101）。セッションの画面にも「続きから録音」を出す
    toast.error('録音は途中で終わりました（接続が長く切れた・ホストが再起動したなど）。そこまでの録音は残っています', {
        duration: 15000,
        action: { label: '続きから録音', onClick: () => void get().continueRecording(sessionId) },
    });
}
