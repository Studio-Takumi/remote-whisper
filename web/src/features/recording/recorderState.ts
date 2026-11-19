// 録音に使うもの（マイク・送信・resume の途中か・届かなかった音声）。React の状態にする必要がないので、
// ストアの外に、ストアごとに 1 つ持つ（spec/flows.md 6.2・6.7）
import type { AudioSender } from '@/api/connection';
import type { ServerMessage } from '@/api/protocol';
import type { AppStore } from '@/app/appState';
import type { Microphone } from '@/features/recording/audio/microphone';
import type { UnsentSession } from '@/features/recording/audio/unsentStore';
import { ClosedRecordings } from '@/features/recording/closedRecordings';
import { MetricsTracker } from '@/features/recording/metricsTracker';
import type { MicRecovery } from '@/features/recording/micRecovery';

export type StartedMessage = Extract<ServerMessage, { type: 'started' }>;
export type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;

export type Recorder = {
    store: AppStore;
    // 録音ごとの数字（#206）
    metrics: MetricsTracker;
    // 録音していたページが閉じられたセッションを終わらせる（#448）
    closed: ClosedRecordings;
    mic: Microphone | null;
    sender: AudioSender | null;
    // 録音のためのメッセージの購読をやめる
    unsubscribe: (() => void) | null;
    // 録音を始めている途中（started を待っている間）
    starting: boolean;
    // つなぎ直して resume を送り、started を待っている間
    resuming: boolean;
    // resume の世代。切れるたびに増やし、前の接続で待っていた resume の結果は捨てる
    resumeGeneration: number;
    // resume の後、最初の ack を受けたら ack されていない音声を送り直す
    resendAfterAck: boolean;
    // 接続が切れている間に録音を終えたセッション。つながり直したら resume して、残りの音声と stop を送る
    stoppedWhileOffline: string | null;
    // 録音が途中で終わったとき、サーバーに届かなかった音声。そのセッションの続きを録音するときに先に送る（#101）
    leftover: { sessionId: string; pcm: Int16Array[] } | null;
    // ページを読み込み直す前に溜めていた音声（IndexedDB から読んだもの。#102）
    unsentEntry: UnsentSession | null;
    // 読み込み直した後に resume したとき、サーバーが受け取り済みの録音の長さ（サンプル数）。最初の ack で使う
    recoveredBase: number | null;
    // 録音した（サーバーに送る）サンプルの数。経過時間はこれから出す（サーバーと同じ時計になる）
    recordedSamples: number;
    // 割り込みのあと、自動で録音に戻す（#447）。最初にマイクを開いたときに作る
    micRecovery: MicRecovery | null;
};

// 切れている間に録音を終えて、まだ stop を送っていないセッション（ストアの外から見るとき）
export function offlineStoppedSession(r: Recorder) {
    return r.stoppedWhileOffline;
}

export function createRecorder(store: AppStore): Recorder {
    return {
        store,
        metrics: new MetricsTracker(),
        closed: new ClosedRecordings(store),
        mic: null,
        sender: null,
        unsubscribe: null,
        starting: false,
        resuming: false,
        resumeGeneration: 0,
        resendAfterAck: false,
        stoppedWhileOffline: null,
        leftover: null,
        unsentEntry: null,
        recoveredBase: null,
        recordedSamples: 0,
        micRecovery: null,
    };
}
