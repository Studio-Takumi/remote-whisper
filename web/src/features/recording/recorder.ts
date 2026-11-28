// 自分の端末での録音：始める・続きから録音する・一時停止・再開・停止・マイクの開き直し（spec/flows.md 6.2）
import { toast } from 'sonner';

import { AudioSender, connection } from '@/api/connection';
import { getHostId } from '@/api/endpoint';
import type { Session } from '@/api/types';
import { replaceUrlNext } from '@/app/router';
import { currentProject, currentSession } from '@/app/selectors';
import { holdSession, projectIdOf } from '@/app/sessionData';
import { patchLocal, putLocal } from '@/features/projects/localSessions';
import { openChosenMicrophone } from '@/features/recording/audio/micDevice';
import { MicrophoneError, SAMPLE_RATE } from '@/features/recording/audio/microphone';
import { clearSession, deleteUpTo, saveChunk } from '@/features/recording/audio/unsentStore';
import { recordingMessages } from '@/features/recording/i18n';
import { micFallbackMessage, micStateMessage, withMicLabel } from '@/features/recording/micMessages';
import { MicRecovery } from '@/features/recording/micRecovery';
import type { ErrorMessage, Recorder, StartedMessage } from '@/features/recording/recorderState';
import { subscribeRecording } from '@/features/recording/recordingMessages';
import { recordedSeconds } from '@/features/recording/recordingMetrics';
import { finalModelLabel, llmModels } from '@/features/settings/settings';
import { getLanguage } from '@/i18n/language';
import { formatDateTime } from '@/lib/time';

// 前の録音の残りをまだ送っていないときの知らせ（始めると、その残りが捨てられてしまう）
const waitingLeftover = () => recordingMessages.t('recorder.waitingLeftover');

// 送る音声を数えて、経過時間を進める。接続が切れて手元に溜めている分も、録音した長さとして数える
export function countRecorded(r: Recorder, pcm: Int16Array) {
    r.recordedSamples += pcm.length;
    const elapsed = Math.floor(r.recordedSamples / SAMPLE_RATE);
    if (elapsed !== r.store.getState().elapsed) {
        r.store.setState({ elapsed });
    }
}

// 割り込みのあと自動で録音に戻すもの（#447）。止まっていた間の時刻の扱いは spec/flows.md 6.7
function micRecoveryOf(r: Recorder) {
    r.micRecovery ??= new MicRecovery({
        active: () => r.store.getState().recordingState === 'recording' && !!r.mic,
        state: () => r.mic?.state() ?? 'ended',
        resume: async () => {
            await r.mic?.restart();
        },
        reopen: () => swapMicrophone(r),
        recovered: () => toast.success(withMicLabel(recordingMessages.t('recorder.recovered'), r.mic?.label())),
    });
    return r.micRecovery;
}

// マイクを開く。届いた音声を送り、マイクが止まったら画面で知らせる（#102）。
// 状態は開けたときに最初の知らせで決まる（開き直しに失敗したら、止まったままの警告を残す）。
// 設定で選んだマイクで開き、ないときは OS に任せて知らせる（#449。自動・手動の開き直しも同じ）
export async function openMicrophone(r: Recorder) {
    const { getState: get, setState: set } = r.store;
    // 古いサーバーは echoCancellation を返さない（そのときはオン）
    const { noiseSuppression, autoGainControl, echoCancellation = true } = get().settings.recording;
    const mic = await openChosenMicrophone(
        (pcm, level) => {
            // 一時停止中の音声は送らない
            if (get().recordingState === 'recording' && r.sender) {
                r.sender.push(pcm);
                countRecorded(r, pcm);
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
            micRecoveryOf(r).changed(micState);
        },
        (chosen) => toast.warning(micFallbackMessage(chosen.label), { duration: 15000 }),
    );
    // 開いた時点で止まっていたときも戻せるよう、見張り始めてから今の状態を伝える
    micRecoveryOf(r).start();
    micRecoveryOf(r).changed(mic.state());
    return mic;
}

// 届いていない音声を IndexedDB に置き、サーバーが受け取ったら消す（#102）
export function persistUnsent(target: AudioSender, sessionId: string, projectId: string) {
    let warned = false;
    target.onFrame = (seq, frame) => {
        void saveChunk(sessionId, projectId, getHostId(), seq, frame).then((saved) => {
            if (!saved && !warned) {
                warned = true;
                toast.warning(recordingMessages.t('recorder.unsentOverflow'));
            }
        });
    };
    target.onAcked = (seq) => void deleteUpTo(sessionId, seq);
}

// マイクを閉じ、録音のためのメッセージの受け取りをやめる
export function closeRecording(r: Recorder) {
    r.micRecovery?.stop();
    r.mic?.close();
    r.mic = null;
    r.sender = null;
    r.recoveredBase = null;
    r.unsubscribe?.();
    r.unsubscribe = null;
}

// マイクを開いてサーバーに start（continue）を送り、started を待つ
async function openRecording(r: Recorder, projectId: string, continueSessionId?: string) {
    closeRecording(r);
    r.stoppedWhileOffline = null;
    r.sender = new AudioSender((pendingAudio) => r.store.setState({ pendingAudio }));
    r.mic = await openMicrophone(r);
    r.unsubscribe = subscribeRecording(r);
    await connection.open();
    // 今回だけ変えた文字起こしの言語（#482）。変えていなければ送らない（全体設定になる）。
    // 表示言語（#498）は、未設定の文字起こしの言語と「表示言語に合わせる」要約の言語に使う
    const language = r.store.getState().nextLanguage;
    connection.send(
        continueSessionId
            ? { type: 'continue', project: projectId, session: continueSessionId }
            : { type: 'start', project: projectId, ...(language ? { language } : {}), displayLanguage: getLanguage() },
    );
    const reply = await connection.waitFor(
        (m): m is StartedMessage | ErrorMessage => m.type === 'started' || m.type === 'error',
        // 続きを録音するときは、サーバーが前の録音（mp3）を WAV に戻すので、長い録音ほど時間がかかる
        continueSessionId ? 60000 : 5000,
    );
    if (reply.type === 'error') {
        throw new Error(reply.message);
    }
    return reply;
}

// 続きを録音する。経過時間と文字起こしの時刻は、前の録音の長さから続ける（#101）
async function beginContinue(r: Recorder, projectId: string, sessionId: string, reply: StartedMessage) {
    r.recordedSamples = Math.round((reply.offsetSec ?? 0) * SAMPLE_RATE);
    r.store.setState((s) => ({
        // 録音している間は、手元で行を積み上げる（#361）
        localSessions: holdSession(s, sessionId, (x) => ({
            ...x,
            status: 'recording',
            endedAt: undefined,
            durationSec: undefined,
        })),
        selection: { projectId, sessionId },
        recordingState: 'recording',
        recordingSessionId: sessionId,
        elapsed: Math.floor(r.recordedSamples / SAMPLE_RATE),
        partials: [],
        liveDraft: null,
    }));
    // 切れている間に録音した分（サーバーに届かなかった音声）を、続きの頭に送る。
    // IndexedDB に置いてあった分は、新しい連番で置き直す
    await clearSession(sessionId);
    if (r.sender) {
        persistUnsent(r.sender, sessionId, projectId);
    }
    if (r.leftover?.sessionId === sessionId && r.sender) {
        for (const pcm of r.leftover.pcm) {
            r.sender.push(pcm);
            countRecorded(r, pcm);
        }
    }
    r.leftover = null;
}

// セッションは録音を始めたときに作る。ID はサーバーが決めた、録音を始めた時刻（spec/files.md 5.2）
function beginNew(r: Recorder, projectId: string, reply: StartedMessage) {
    const created: Session = {
        id: reply.session,
        uuid: reply.sessionUuid ?? undefined,
        title: recordingMessages.t('common.newSession'),
        startedAt: formatDateTime(),
        status: 'recording',
        loaded: true,
        transcript: [],
        summaries: [],
    };
    r.recordedSamples = 0;
    if (r.sender) {
        persistUnsent(r.sender, created.id, projectId);
    }
    // 新規セッション画面の URL を、このセッションの URL に置き換える（履歴は増やさない。#177）
    replaceUrlNext();
    r.store.setState((s) => ({
        // 先に一覧の取り直しでサーバーのものが入っていることがあるが、手元のものを先に使う
        localSessions: putLocal(s.localSessions, { projectId, session: created }),
        selection: { projectId, sessionId: created.id },
        recordingState: 'recording',
        recordingSessionId: created.id,
        elapsed: 0,
        partials: [],
        liveDraft: null,
    }));
}

async function beginRecording(r: Recorder, projectId: string, continueSessionId?: string) {
    const reply = await openRecording(r, projectId, continueSessionId);
    const offset = continueSessionId ? Math.round((reply.offsetSec ?? 0) * SAMPLE_RATE) : 0;
    r.metrics.start(
        !!continueSessionId,
        continueSessionId ?? reply.session,
        recordedSeconds(offset, SAMPLE_RATE),
        r.store.getState().settings,
        r.sender,
    );
    if (continueSessionId) {
        await beginContinue(r, projectId, continueSessionId, reply);
    } else {
        beginNew(r, projectId, reply);
    }
}

// 録音を始める（continueSessionId があれば、途中で終わったそのセッションの続きを録音する）
export async function startOrContinue(r: Recorder, projectId: string, continueSessionId?: string) {
    r.starting = true;
    try {
        await beginRecording(r, projectId, continueSessionId);
    } catch (e) {
        closeRecording(r);
        if (e instanceof MicrophoneError && e.reason === 'denied') {
            r.store.setState((s) => ({ server: { ...s.server, microphone: 'denied' } }));
            toast.error(recordingMessages.t('recorder.micDenied'));
        } else {
            toast.error((e as Error).message);
        }
    } finally {
        r.starting = false;
    }
}

// 開いているプロジェクトで、新しいセッションを録音する
export async function startRecording(r: Recorder) {
    const s = r.store.getState();
    const project = currentProject(s);
    if (!project) {
        toast.info(recordingMessages.t('common.chooseProject'));
        return;
    }
    // 既存のセッションを開いていたら、同じプロジェクトの新しいセッションの画面に切り替えるだけにする
    // 録音を始める前に、モデルや参考資料を選び直せるようにするため
    if (currentSession(s)) {
        r.store.setState({ selection: { projectId: project.id, sessionId: null } });
        return;
    }
    if (s.recordingState !== 'idle' || r.starting) {
        return;
    }
    if (r.stoppedWhileOffline) {
        toast.warning(waitingLeftover());
        return;
    }
    await startOrContinue(r, project.id);
}

// 途中で終わったセッションの続きを、同じセッションのまま録音する（#101）
export async function continueRecording(r: Recorder, sessionId: string) {
    const s = r.store.getState();
    const projectId = projectIdOf(s, sessionId);
    if (!projectId || s.recordingState !== 'idle' || r.starting) {
        return;
    }
    if (r.stoppedWhileOffline) {
        toast.warning(waitingLeftover());
        return;
    }
    await startOrContinue(r, projectId, sessionId);
}

// 一時停止の前までの音声を送り切ってから pause を送る
export async function pauseRecording(r: Recorder) {
    await r.mic?.flush();
    r.sender?.flush();
    r.metrics.pause();
    connection.send({ type: 'pause' });
    r.store.setState({ recordingState: 'paused', micLevel: 0 });
}

export function unpauseRecording(r: Recorder) {
    // 一時停止中に worklet に溜まった音は送らない
    r.mic?.discard();
    connection.send({ type: 'unpause' });
    r.store.setState({ recordingState: 'recording' });
    // 一時停止の間は自動で戻さないので、再開したときに止まっていれば戻す（#447）
    if (r.mic) {
        void micRecoveryOf(r).retryNow('unpause');
    }
}

// 録音を終えたら、セッションの終了日時と状態を確定して、最終の要約を作り始める
export async function stopRecording(r: Recorder) {
    const { getState: get, setState: set } = r.store;
    // 終了の前までの音声（worklet と手元に溜まっている分）を送り切ってから stop を送る
    if (get().recordingState === 'recording') {
        await r.mic?.flush();
    }
    r.sender?.flush();
    const sessionId = get().recordingSessionId;
    if (sessionId) {
        // 最終の要約ができたときに送る
        r.metrics.stop(sessionId, get().elapsed);
    }
    if (r.sender && !r.sender.holding) {
        connection.send({ type: 'stop' });
    } else {
        // 切れていて音声を溜めている間は、つながり直して溜めた音声を送ってから stop を送る
        r.stoppedWhileOffline = sessionId;
    }
    // 最後に送った音声の ack を受け取れるように、購読は次の録音を始めるまで続ける
    r.micRecovery?.stop();
    r.mic?.close();
    r.mic = null;
    const endedAt = formatDateTime();
    set((s) => ({
        recordingState: 'idle',
        recordingSessionId: null,
        micLevel: 0,
        transcriptionStalled: false,
        // 流れている途中で終えると summary.done（live）が来ないので、書きかけの途中の要約は捨てる
        liveDraft: null,
        localSessions: sessionId
            ? // 長さはサーバーと同じ時計の経過時間。取り直すまでの間も、サイドバーに秒まで出せるように
              patchLocal(s.localSessions, sessionId, (x) => ({
                  ...x,
                  status: 'done',
                  endedAt,
                  durationSec: s.elapsed,
              }))
            : s.localSessions,
        // 最終の要約はサーバーが作り、summary.delta（final）で届く。届くまでは「作成中」と出す
        generating: sessionId ? { sessionId, model: finalModelLabel(llmModels(s.settings)), text: '' } : s.generating,
    }));
}

// 止まったマイクを開き直す（録音はそのまま続ける。#102）
export async function reopenMicrophone(r: Recorder) {
    if (r.store.getState().recordingState === 'idle' || !r.mic) {
        return;
    }
    try {
        if (r.store.getState().micState === 'suspended') {
            await r.mic.restart();
            return;
        }
        await swapMicrophone(r);
        toast.success(withMicLabel(recordingMessages.t('recorder.reopened'), r.mic?.label()));
    } catch (e) {
        toast.error(recordingMessages.t('recorder.reopenFailed', { message: (e as Error).message }));
    }
}

// 設定で録音に使うマイクを選び直したとき（#449）。録音中なら、録音を続けたまま選んだマイクで開き直す
export async function switchMicrophone(r: Recorder) {
    // 開き直している途中（#447 の自動など）は、選び直す前の選択で開いているので、終わるのを待ってから開き直す
    await swapping.get(r)?.catch(() => {});
    if (r.store.getState().recordingState === 'idle' || !r.mic) {
        return;
    }
    try {
        await swapMicrophone(r);
        toast.success(withMicLabel(recordingMessages.t('recorder.switched'), r.mic?.label()));
    } catch (e) {
        toast.error(recordingMessages.t('recorder.switchFailed', { message: (e as Error).message }));
    }
}

// 開き直している途中のもの。手動と自動が重なっても、getUserMedia を 1 本にする（#447）
const swapping = new WeakMap<Recorder, Promise<void>>();

// 止まったトラックは戻らないので、マイクを開き直す（送信と経過時間はそのまま続く）
function swapMicrophone(r: Recorder) {
    let running = swapping.get(r);
    if (!running) {
        running = replaceMicrophone(r).finally(() => swapping.delete(r));
        swapping.set(r, running);
    }
    return running;
}

async function replaceMicrophone(r: Recorder) {
    const next = await openMicrophone(r);
    // 開いている間に録音を終えていたら、開いたものを閉じる
    if (!r.mic || r.store.getState().recordingState === 'idle') {
        r.micRecovery?.stop();
        next.close();
        return;
    }
    r.mic.close();
    r.mic = next;
}
