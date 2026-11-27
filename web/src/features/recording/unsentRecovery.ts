// ページを読み込み直す前に、サーバーに届かなかった音声（IndexedDB に置いてあったもの。#102・#227）
import { toast } from 'sonner';

import { AudioSender, connection } from '@/api/connection';
import { getHostId } from '@/api/endpoint';
import { holdSession } from '@/app/sessionData';
import { SAMPLE_RATE } from '@/features/recording/audio/microphone';
import {
    type UnsentSession,
    clearSession,
    listUnsent,
    restoreSize,
    splitByHost,
    unsentSeconds,
} from '@/features/recording/audio/unsentStore';
import { recordingMessages } from '@/features/recording/i18n';
import { closeRecording, openMicrophone, persistUnsent, startOrContinue } from '@/features/recording/recorder';
import type { ErrorMessage, Recorder, StartedMessage } from '@/features/recording/recorderState';
import { subscribeRecording } from '@/features/recording/recordingMessages';

// 前に届かなかった音声が残っていないか。復旧するのは今のホストのものだけで、
// ほかのホストのものは知らせるだけにして、そのホストにつないだときに復旧する（#227。spec/cloud.md 10.6）
export async function loadUnsent(r: Recorder) {
    const { mine: entry, elsewhere } = splitByHost(await listUnsent(), getHostId());
    r.store.setState({ unsentElsewhere: elsewhere });
    if (!entry || r.store.getState().recordingState !== 'idle') {
        return;
    }
    r.unsentEntry = entry;
    r.store.setState({
        unsent: { sessionId: entry.session, projectId: entry.project, seconds: unsentSeconds(entry.frames) },
    });
}

// 溜めていたチャンクのまま、同じ連番で resume を送る（サーバーが受け取り済みの分は ack の後で捨てる）
async function resumeUnsent(r: Recorder, entry: UnsentSession) {
    const { session: sessionId, project: projectId } = entry;
    closeRecording(r);
    r.stoppedWhileOffline = null;
    r.sender = AudioSender.restore(entry.frames, (pendingAudio) => r.store.setState({ pendingAudio }));
    restoreSize(sessionId, entry.frames);
    persistUnsent(r.sender, sessionId, projectId);
    r.mic = await openMicrophone(r);
    r.unsubscribe = subscribeRecording(r);
    await connection.open();
    connection.send({ type: 'resume', session: sessionId, nextSeq: r.sender.nextSeq });
    return connection.waitFor(
        (m): m is StartedMessage | ErrorMessage =>
            (m.type === 'started' && m.session === sessionId) || m.type === 'error',
        10000,
    );
}

// resume が通った。続く ack を受けたら溜めていた音声を送り直し、経過時間は受け取り済みの分を除いてから決める
function recordResumed(r: Recorder, entry: UnsentSession, reply: StartedMessage) {
    const { session: sessionId, project: projectId } = entry;
    r.resendAfterAck = true;
    r.recoveredBase = Math.round((reply.offsetSec ?? 0) * SAMPLE_RATE);
    r.recordedSamples = r.recoveredBase;
    r.unsentEntry = null;
    r.store.setState((s) => ({
        unsent: null,
        localSessions: holdSession(s, sessionId, (x) => ({ ...x, status: 'recording' })),
        selection: { projectId, sessionId },
        recordingState: 'recording',
        recordingSessionId: sessionId,
        elapsed: Math.floor(r.recordedSamples / SAMPLE_RATE),
        partials: [],
        liveDraft: null,
    }));
}

// 届かなかった音声を送り、同じセッションの続きを録音する
export async function recoverUnsent(r: Recorder) {
    const entry = r.unsentEntry;
    if (!entry || r.store.getState().recordingState !== 'idle' || r.starting) {
        return;
    }
    r.starting = true;
    r.resuming = true;
    try {
        const reply = await resumeUnsent(r, entry);
        if (reply.type === 'started') {
            recordResumed(r, entry, reply);
            return;
        }
        if (reply.code !== 'session_not_found') {
            throw new Error(reply.message);
        }
        // 待つ時間を過ぎて途中で終わっていた。届かなかった音声を頭に足して、続きを録音する（#101）
        r.leftover = { sessionId: entry.session, pcm: r.sender?.unsent() ?? [] };
        closeRecording(r);
        r.unsentEntry = null;
        r.store.setState({ unsent: null });
        r.starting = false;
        await startOrContinue(r, entry.project, entry.session);
    } catch (e) {
        closeRecording(r);
        toast.error(recordingMessages.t('unsentRecovery.sendFailed', { message: (e as Error).message }));
    } finally {
        r.starting = false;
        r.resuming = false;
    }
}

// 届かなかった音声を捨てる
export async function discardUnsent(r: Recorder) {
    const entry = r.unsentEntry;
    r.unsentEntry = null;
    r.store.setState({ unsent: null });
    if (entry) {
        await clearSession(entry.session);
        // 続きを送らないので、サーバーが待っていれば待たずに終わりにする（#448）
        // （切れていれば、つながったときに確かめる）
        if (connection.isOpen) {
            void r.closed.interruptClosed();
        }
    }
}

// ほかのホストの届かなかった音声を捨てる（外したホストと、どのホストのものか分からないもの）
export async function discardUnsentElsewhere(r: Recorder, hosts: (string | null)[]) {
    const entries = r.store.getState().unsentElsewhere.filter((e) => hosts.includes(e.host));
    r.store.setState((s) => ({ unsentElsewhere: s.unsentElsewhere.filter((e) => !hosts.includes(e.host)) }));
    for (const session of entries.flatMap((e) => e.sessions)) {
        await clearSession(session);
    }
}
