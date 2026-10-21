// 録音ごとの数字を手元で集めて、Worker に送る（#206。docs/spec/cloud.md 10.9 節）。クラウド版のときだけ使う。
// 送るのは数字と、決まった値（モデル名・error の code）だけ。音声、文字起こし・要約・タイトル・用語の本文、
// プロジェクト名・ファイル名、error の文面、セッション ID は集めない（このファイルに持たない）
import type { ServerMessage } from '@/protocol';
import type { Settings } from '@/settings';

// 小さい順に並べた値の、p 番目（0〜1）。最も近い順位の方法。空なら undefined
export function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function median(values: number[]) {
    return percentile(values, 0.5);
}

// ack の往復（ms）の中央値・90%・最大。サンプルがなければ空
export function summarizeRtt(samples: number[]): { rttP50Ms?: number; rttP90Ms?: number; rttMaxMs?: number } {
    if (samples.length === 0) {
        return {};
    }
    return {
        rttP50Ms: Math.round(median(samples) ?? 0),
        rttP90Ms: Math.round(percentile(samples, 0.9) ?? 0),
        rttMaxMs: Math.round(Math.max(...samples)),
    };
}

// 録音した秒数（一時停止を除く）。録音した音声のサンプル数から数える（時計では数えない）
export function recordedSeconds(samples: number, sampleRate: number) {
    return Math.floor(samples / sampleRate);
}

export type MetricsSettings = {
    whisperModel: string;
    summaryModel: string;
    overviewModel: string;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    echoCancellation: boolean;
};

export type MetricsPayload = Record<string, number | boolean | string | Record<string, number>>;

type StatusMessage = Extract<ServerMessage, { type: 'status' }>;

const sec = (ms: number) => Math.max(0, Math.round(ms / 100) / 10);

export class RecordingMetrics {
    private readonly now: () => number;
    private readonly upload: boolean;
    private readonly continued: boolean;
    private readonly settings: MetricsSettings | null;

    private startedAt: number;
    private stoppedAt: number | null = null;
    private recordingSec: number | undefined;
    private pauses = 0;
    private sentAt = new Map<number, number>();
    private rtts: number[] = [];
    private chunksSent = 0;
    private chunksAcked = 0;
    private lastAcked = -1;
    private reconnects = 0;
    private offlineSince: number | null = null;
    private offlineMs = 0;
    private maxBufferedSec = 0;
    private partials = 0;
    private finals = 0;
    private firstFinalSec: number | undefined;
    private stalls = 0;
    private stalled = false;
    private liveSummaries = 0;
    private finalSummarySec: number | undefined;
    private finalTranscriptSec: number | undefined;
    private gpuQueueMax = 0;
    private gpuUtilSum = 0;
    private gpuUtilCount = 0;
    private gpuUtilMax = 0;
    private vramMaxMb = 0;
    private whisperDown = 0;
    private ollamaDown = 0;
    private whisperError = false;
    private ollamaError = false;
    private errors: Record<string, number> = {};
    private done = false;

    constructor(
        options: {
            upload?: boolean;
            continued?: boolean;
            settings?: MetricsSettings;
            now?: () => number;
        } = {},
    ) {
        this.now = options.now ?? Date.now;
        this.upload = options.upload ?? false;
        this.continued = options.continued ?? false;
        this.settings = options.settings ?? null;
        this.startedAt = this.now();
    }

    // --- 録音 ---
    pause() {
        this.pauses += 1;
    }

    // 録音を終えた。seconds は録音した秒数（一時停止を除く）
    stop(seconds: number) {
        if (this.stoppedAt === null) {
            this.stoppedAt = this.now();
            this.recordingSec = seconds;
        }
    }

    get stopped() {
        return this.stoppedAt !== null;
    }

    // アップロードしたファイルは、アップロードできたときから最終の要約を待つ
    awaitSummary() {
        this.startedAt = this.now();
        this.stoppedAt = this.startedAt;
    }

    // --- 遅延 ---
    // チャンクを作った。bufferedSec は、そのときサーバーに届いていない音声の秒数
    chunkSent(seq: number, bufferedSec: number) {
        this.chunksSent += 1;
        this.sentAt.set(seq, this.now());
        this.maxBufferedSec = Math.max(this.maxBufferedSec, bufferedSec);
    }

    // ack は、その連番までを受け取ったという意味。往復は、その連番のチャンクを送ってからの時間で測る
    ack(seq: number) {
        const sent = this.sentAt.get(seq);
        if (sent !== undefined) {
            this.rtts.push(this.now() - sent);
        }
        for (const key of [...this.sentAt.keys()]) {
            if (key <= seq) {
                this.sentAt.delete(key);
            }
        }
        if (seq > this.lastAcked) {
            // 連番は 0 から。ack されたチャンクの数
            this.chunksAcked += seq - this.lastAcked;
            this.lastAcked = seq;
        }
    }

    // --- 接続 ---
    connection(connected: boolean) {
        if (!connected) {
            if (this.offlineSince === null) {
                this.offlineSince = this.now();
            }
            return;
        }
        if (this.offlineSince !== null) {
            this.offlineMs += this.now() - this.offlineSince;
            this.offlineSince = null;
            this.reconnects += 1;
        }
    }

    // --- 文字起こし ---
    partial() {
        this.partials += 1;
    }

    final() {
        this.finals += 1;
        this.firstFinalSec ??= sec(this.now() - this.startedAt);
    }

    transcriptionStalled(stalled: boolean) {
        if (stalled && !this.stalled) {
            this.stalls += 1;
        }
        this.stalled = stalled;
    }

    // --- 要約 ---
    liveSummaryDone() {
        this.liveSummaries += 1;
    }

    finalTranscriptDone() {
        if (this.stoppedAt !== null) {
            this.finalTranscriptSec ??= sec(this.now() - this.stoppedAt);
        }
    }

    finalSummaryDone() {
        if (this.stoppedAt !== null) {
            this.finalSummarySec ??= sec(this.now() - this.stoppedAt);
        }
    }

    // --- ホストの状態 ---
    status(m: StatusMessage) {
        const waiting = m.jobs ? m.jobs.waiting.reduce((n, j) => n + j.count, 0) + (m.jobs.running ? 1 : 0) : 0;
        this.gpuQueueMax = Math.max(this.gpuQueueMax, waiting);
        if (m.gpu) {
            this.gpuUtilSum += m.gpu.util;
            this.gpuUtilCount += 1;
            this.gpuUtilMax = Math.max(this.gpuUtilMax, m.gpu.util);
            this.vramMaxMb = Math.max(this.vramMaxMb, m.gpu.memUsedMb);
        }
        // つながらなくなった回数は、正常から error に変わったときに数える
        if (m.whisper === 'error' && !this.whisperError) {
            this.whisperDown += 1;
        }
        if (m.ollama === 'error' && !this.ollamaError) {
            this.ollamaDown += 1;
        }
        this.whisperError = m.whisper === 'error';
        this.ollamaError = m.ollama === 'error';
    }

    // サーバーからのメッセージのうち、数えるものを数える。session は今の録音のセッション（違うセッションのものは数えない）
    receive(m: ServerMessage, session: string | null) {
        if ('session' in m && m.session !== undefined && m.session !== session) {
            return;
        }
        switch (m.type) {
            case 'ack':
                this.ack(m.seq);
                break;
            case 'partial':
                this.partial();
                break;
            case 'final':
                this.final();
                break;
            case 'transcriptionStalled':
                this.transcriptionStalled(m.stalled);
                break;
            case 'summary.done':
                if (m.kind === 'live') {
                    this.liveSummaryDone();
                }
                break;
            case 'finalTranscript':
                this.finalTranscriptDone();
                break;
            case 'status':
                // 録音を終えたあとの status は、ホストの状態として数えない
                if (!this.stopped) {
                    this.status(m);
                }
                break;
            case 'error':
                this.error(m.code);
                break;
        }
    }

    // error の code ごとの件数。文面は受け取らない
    error(code: string) {
        this.errors[code] = (this.errors[code] ?? 0) + 1;
    }

    // --- 送るもの ---
    // 送る本文を作る。1 つの録音につき 1 回だけ作れる（2 回目は null）。ページを閉じるときは、その時点までを作る
    take(hostId: string): MetricsPayload | null {
        if (this.done) {
            return null;
        }
        this.done = true;
        const offlineMs = this.offlineMs + (this.offlineSince !== null ? this.now() - this.offlineSince : 0);
        const numbers: Record<string, number | undefined> = {
            recordingSec: this.recordingSec,
            pauses: this.upload ? undefined : this.pauses,
            ...summarizeRtt(this.rtts),
            chunksSent: this.upload ? undefined : this.chunksSent,
            chunksAcked: this.upload ? undefined : this.chunksAcked,
            reconnects: this.upload ? undefined : this.reconnects,
            offlineSec: this.upload ? undefined : sec(offlineMs),
            maxBufferedSec: this.upload ? undefined : Math.round(this.maxBufferedSec),
            partials: this.upload ? undefined : this.partials,
            finals: this.upload ? undefined : this.finals,
            firstFinalSec: this.firstFinalSec,
            stalls: this.upload ? undefined : this.stalls,
            liveSummaries: this.upload ? undefined : this.liveSummaries,
            finalSummarySec: this.finalSummarySec,
            finalTranscriptSec: this.finalTranscriptSec,
            gpuQueueMax: this.upload ? undefined : this.gpuQueueMax,
            gpuUtilAvg: this.gpuUtilCount > 0 ? Math.round(this.gpuUtilSum / this.gpuUtilCount) : undefined,
            gpuUtilMax: this.gpuUtilCount > 0 ? this.gpuUtilMax : undefined,
            vramMaxMb: this.gpuUtilCount > 0 ? Math.round(this.vramMaxMb) : undefined,
            whisperDown: this.whisperDown,
            ollamaDown: this.ollamaDown,
        };
        const payload: MetricsPayload = { hostId, upload: this.upload, continued: this.continued };
        for (const [key, value] of Object.entries(numbers)) {
            if (value !== undefined && Number.isFinite(value)) {
                payload[key] = value;
            }
        }
        if (this.settings) {
            Object.assign(payload, this.settings);
        }
        if (Object.keys(this.errors).length > 0) {
            payload.errors = { ...this.errors };
        }
        return payload;
    }
}

export const METRICS_URL = '/me/metrics/recording';

// Worker に送る。クラウド版でなければ何もしない（false）。失敗しても画面は止めない。
// beacon は pagehide のとき（navigator.sendBeacon）。送れた（送る手続きに入った）ら true
export function sendRecordingMetrics(
    metrics: RecordingMetrics | null | undefined,
    where: {
        cloud: boolean;
        hostId: string | null;
        url: string;
        beacon?: boolean;
        fetchFn?: typeof fetch;
        sendBeacon?: (url: string, data: Blob) => boolean;
    },
): boolean {
    if (!where.cloud || !metrics || !where.hostId) {
        return false;
    }
    const payload = metrics.take(where.hostId);
    if (!payload) {
        return false;
    }
    const body = JSON.stringify(payload);
    try {
        if (where.beacon && where.sendBeacon) {
            return where.sendBeacon(where.url, new Blob([body], { type: 'application/json' }));
        }
        void (where.fetchFn ?? fetch)(where.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {});
        return true;
    } catch {
        return false;
    }
}

// 使った設定（モデル名とマイクの処理）。古いサーバーの設定に echoCancellation がなければオンとみなす
export function metricsSettings(settings: Settings): MetricsSettings {
    const { noiseSuppression, autoGainControl, echoCancellation = true } = settings.recording;
    return {
        whisperModel: settings.whisper.model,
        summaryModel: settings.ollama.models.detail,
        overviewModel: settings.ollama.models.overview,
        noiseSuppression,
        autoGainControl,
        echoCancellation,
    };
}
