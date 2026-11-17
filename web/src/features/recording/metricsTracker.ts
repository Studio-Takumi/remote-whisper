// 録音ごとの数字（#206。クラウド版のときだけ集めて送る）。今の（直近の）録音のものと、
// 録音を終えて最終の要約を待っているものを持つ
import type { AudioSender } from '@/api/connection';
import { isDemo } from '@/api/demo';
import { getHostId, isCloud, meUrl } from '@/api/endpoint';
import type { ServerMessage } from '@/api/protocol';
import { RecordingMetrics, metricsSettings, sendRecordingMetrics } from '@/features/recording/recordingMetrics';
import type { Settings } from '@/features/settings/settings';

function send(m: RecordingMetrics, beacon = false) {
    sendRecordingMetrics(m, {
        cloud: isCloud,
        url: meUrl('/metrics/recording'),
        beacon,
        sendBeacon: (url, data) => navigator.sendBeacon(url, data),
    });
}

export class MetricsTracker {
    private current: RecordingMetrics | null = null;
    private session: string | null = null;
    private readonly awaiting = new Map<string, RecordingMetrics>();

    // 集め始める。baseSec は、続きから録音するときの前の録音の長さ（秒）
    start(continued: boolean, sessionId: string, baseSec: number, settings: Settings, sender: AudioSender | null) {
        this.current = null;
        this.session = null;
        if (!isCloud || isDemo) {
            return;
        }
        const m = new RecordingMetrics({
            continued,
            baseSec,
            hostId: getHostId(),
            settings: metricsSettings(settings),
        });
        this.current = m;
        this.session = sessionId;
        if (sender) {
            sender.onChunk = (seq, bufferedSec, holding) => m.chunkSent(seq, bufferedSec, holding);
        }
    }

    receive(m: ServerMessage) {
        this.current?.receive(m, this.session);
    }

    pause() {
        this.current?.pause();
    }

    connection(connected: boolean) {
        this.current?.connection(connected);
    }

    // 録音を終えた。最終の要約ができたときに送る
    stop(sessionId: string, elapsed: number) {
        if (this.current) {
            this.current.stop(Math.floor(elapsed));
            this.awaiting.set(sessionId, this.current);
        }
    }

    // 録音が途中で終わった。最終の要約は来ないので、ここまでの数字をすぐ送る
    interrupt(sessionId: string, elapsed: number) {
        if (this.current && this.session === sessionId) {
            this.current.stop(Math.floor(elapsed));
            this.current.summaryFailed();
            send(this.current);
        }
    }

    // 最終の要約まで待っていた録音の数字を送る。ok でなければ失敗（または分からない）として、秒数を入れずに送る
    finish(sessionId: string, ok: boolean) {
        const m = this.awaiting.get(sessionId);
        if (!m) {
            return;
        }
        this.awaiting.delete(sessionId);
        if (ok) {
            m.finalSummaryDone();
        } else {
            m.summaryFailed();
        }
        send(m);
    }

    // 音声ファイルから作ったセッションの数字。最終の要約ができるまで待つ
    awaitUpload(sessionId: string, settings: Settings) {
        if (!isCloud) {
            return;
        }
        const m = new RecordingMetrics({
            upload: true,
            hostId: getHostId(),
            settings: metricsSettings(settings, true),
        });
        m.awaitSummary();
        this.awaiting.set(sessionId, m);
    }

    // ページを閉じるとき、その時点までの数字を送る（同じ録音を 2 回送らない）
    sendAll(recording: boolean, elapsed: number) {
        if (this.current && recording) {
            this.current.stop(Math.floor(elapsed));
            send(this.current, true);
        }
        for (const m of this.awaiting.values()) {
            send(m, true);
        }
        this.awaiting.clear();
    }
}
