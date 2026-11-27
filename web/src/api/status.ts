import { apiMessages } from '@/api/i18n';
import type { GpuJobKind, GpuJobProgress, GpuJobs, GpuStats } from '@/api/protocol';
import type { RecordingState } from '@/features/recording/recording';
import { LLM_NAMES, type LlmBackend } from '@/features/settings/settings';

// サーバーとブラウザの状態。whisper・ollama・lmstudio・jobs・gpu は WebSocket の status メッセージ（spec/api.md 7.2 節）から、
// connection は WebSocket がつながっているか、microphone はマイクの許可から、ブラウザ側で決める
export type ServerStatus = {
    whisper: 'unloaded' | 'loading' | 'ready' | 'error';
    ollama: 'ready' | 'error';
    // LM Studio（#324）。一度も使っていなければ来ない
    lmstudio?: 'ready' | 'error';
    connection: 'connected' | 'reconnecting';
    microphone: 'granted' | 'denied';
    jobs: GpuJobs;
    // jobs を受け取った時刻（Date.now()）。経過時間を数え足すのに使う
    jobsAt: number;
    gpu: GpuStats | null;
    // 最終の文字起こしを作っているセッション（#124）
    transcribing: string[];
    // 最終の要約を作っているセッション（#118）。移せるかどうか（#172）に使う
    summarizing: string[];
};

export const initialServerStatus: ServerStatus = {
    whisper: 'unloaded',
    ollama: 'ready',
    connection: 'connected',
    microphone: 'granted',
    jobs: { running: null, waiting: [] },
    jobsAt: 0,
    gpu: null,
    transcribing: [],
    summarizing: [],
};

// GPU キューのジョブの種類の名前
const jobKindKeys = {
    transcribe: 'status.jobKindTranscribe',
    whisperLoad: 'status.jobKindTranscriptModelLoad',
    liveSummary: 'status.jobKindLiveSummary',
    finalSummary: 'status.jobKindFinalSummary',
    contextSet: 'status.jobKindReferenceMaterials',
    terms: 'status.jobKindTerms',
    finalTranscript: 'status.jobKindPolish',
    materialRange: 'status.jobKindMaterialRange',
    other: 'status.jobKindOther',
} as const satisfies Record<GpuJobKind, string>;

export function jobKindLabel(kind: GpuJobKind): string {
    return apiMessages.t(jobKindKeys[kind]);
}

// 実行中のジョブの段階の名前（#340。spec/api.md 7.2）
type StepKey =
    | 'status.stepSummary'
    | 'status.stepDetailedSummary'
    | 'status.stepCondense'
    | 'status.stepOverview'
    | 'status.stepPages'
    | 'status.stepTitle'
    | 'status.stepLoad'
    | 'status.stepTranscribe'
    | 'status.stepAlign'
    | 'status.stepSpeakerLabeling';

const jobStepKeys: Partial<Record<GpuJobKind, Record<string, StepKey>>> = {
    finalSummary: {
        summary: 'status.stepSummary',
        parts: 'status.stepDetailedSummary',
        condense: 'status.stepCondense',
        overview: 'status.stepOverview',
        pages: 'status.stepPages',
        title: 'status.stepTitle',
    },
    finalTranscript: {
        load: 'status.stepLoad',
        transcribe: 'status.stepTranscribe',
        align: 'status.stepAlign',
        diarize: 'status.stepSpeakerLabeling',
    },
};

// 知らない段階は null
function jobStepLabel(kind: GpuJobKind, step: string): string | null {
    const key = jobStepKeys[kind]?.[step];
    return key === undefined ? null : apiMessages.t(key);
}

// 実行中のジョブの進み具合の文（「要約詳細 3/6」「位置合わせ 2/4 37%」）と、バーの割合（0〜1。分からなければ null）
// 進み具合がない（古いサーバー・ほかのジョブ）・知らない段階なら null（今までどおりの表示にする）
export function jobProgress(
    kind: GpuJobKind,
    progress: GpuJobProgress | undefined,
): { text: string; ratio: number | null } | null {
    const label = progress && jobStepLabel(kind, progress.step);
    if (!progress || !label) {
        return null;
    }
    const { done, total, percent } = progress;
    const counted = typeof done === 'number' && typeof total === 'number' && total > 0;
    const hasPercent = typeof percent === 'number' && Number.isFinite(percent);
    const parts = [label];
    if (counted) {
        parts.push(`${done}/${total}`);
    }
    if (hasPercent) {
        parts.push(`${Math.floor(percent)}%`);
    }
    // 済んだ数に、今の段階の中の % を足す（段階の重さの差は見ない）
    const within = hasPercent ? percent / 100 : 0;
    const ratio = counted ? (done + within) / total : hasPercent ? within : null;
    return { text: parts.join(' '), ratio: ratio === null ? null : Math.min(1, Math.max(0, ratio)) };
}

// 文字起こしを待たせている理由
type BlockingKey =
    | 'status.blockedByLiveSummary'
    | 'status.blockedByFinalSummary'
    | 'status.blockedByReferenceMaterials'
    | 'status.blockedByTerms'
    | 'status.blockedByPolish'
    | 'status.blockedByMaterialRange';

const blockingReasonKeys: Partial<Record<GpuJobKind, BlockingKey>> = {
    liveSummary: 'status.blockedByLiveSummary',
    finalSummary: 'status.blockedByFinalSummary',
    contextSet: 'status.blockedByReferenceMaterials',
    terms: 'status.blockedByTerms',
    finalTranscript: 'status.blockedByPolish',
    materialRange: 'status.blockedByMaterialRange',
};

function blockingReason(kind: GpuJobKind): string {
    return apiMessages.t(blockingReasonKeys[kind] ?? 'status.blockedByOther');
}

// このセッションの最終の文字起こし（#121）を作っている・作るのを待っているか
export function makingFinalTranscript(jobs: GpuJobs, sessionId: string) {
    const mine = (j: { kind: GpuJobKind; session: string | null } | null) =>
        j?.kind === 'finalTranscript' && j.session === sessionId;
    return mine(jobs.running) || jobs.waiting.some(mine);
}

// 文字起こし以外のジョブ（要約など）が GPU を使っていて、このセッションの文字起こしが後ろで待たされているか
export function transcriptWaitingFor(jobs: GpuJobs, sessionId: string | null): GpuJobKind | null {
    const running = jobs.running;
    if (!sessionId || !running || running.kind === 'transcribe' || running.kind === 'whisperLoad') {
        return null;
    }
    // 文字起こしのモデルの読み込みが待たされているときも同じ（前のセッションの最終の要約の後ろなど）
    const waiting = jobs.waiting.some(
        (w) => (w.kind === 'transcribe' || w.kind === 'whisperLoad') && w.session === sessionId,
    );
    return waiting ? running.kind : null;
}

// StatusIndicator に出す内容
export type Tone = 'idle' | 'active' | 'paused' | 'warning' | 'error';
export type Status = { tone: Tone; text: string };

// 文字起こしタブ用。sessionId は録音中のセッション
export function transcriptStatus(state: RecordingState, server: ServerStatus, sessionId: string | null = null): Status {
    if (state === 'idle') {
        return server.connection === 'reconnecting'
            ? { tone: 'warning', text: apiMessages.t('status.transcriptIdleReconnecting') }
            : { tone: 'idle', text: apiMessages.t('status.transcriptIdle') };
    }
    if (server.connection === 'reconnecting') {
        // つながり直せば、そのまま続く。待つ時間を過ぎても、あとで同じセッションの続きを録音できる（#101）
        return {
            tone: 'warning',
            text: apiMessages.t('status.transcriptReconnecting'),
        };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: apiMessages.t('status.transcriptPaused') };
    }
    if (server.whisper === 'error') {
        return { tone: 'error', text: apiMessages.t('status.transcriptStopped') };
    }
    // GPU は1つずつしか使えず、実行中の要約は途中で止めないので、終わるまで文字起こしが待たされる（spec/flows.md 6.3）
    // モデルの読み込みもその後ろで待つので、読み込み中の表示より先に見る
    const blocking = transcriptWaitingFor(server.jobs, sessionId);
    if (blocking) {
        return {
            tone: 'warning',
            text: apiMessages.t('status.transcriptWaiting', { reason: blockingReason(blocking) }),
        };
    }
    if (server.whisper !== 'ready') {
        return { tone: 'warning', text: apiMessages.t('status.transcriptLoadingModel') };
    }
    return { tone: 'active', text: apiMessages.t('status.transcriptRunning') };
}

// 選んでいる LLM（llm.backend）につながらないか。使っていないほうの状態は見ない（#327）
export function llmUnavailable(server: Pick<ServerStatus, 'ollama' | 'lmstudio'>, backend: LlmBackend): boolean {
    return backend === 'lmstudio' ? server.lmstudio === 'error' : server.ollama === 'error';
}

// 要約タブ用。録音していないときは出さない。backend は設定で選んでいる LLM
export function summaryStatus(
    state: RecordingState,
    server: ServerStatus,
    intervalMin: number,
    backend: LlmBackend = 'ollama',
): Status | null {
    if (state === 'idle') {
        return null;
    }
    if (server.connection === 'reconnecting') {
        return { tone: 'warning', text: apiMessages.t('status.summaryReconnecting') };
    }
    if (llmUnavailable(server, backend)) {
        return {
            tone: 'error',
            text: apiMessages.t('status.summaryLlmUnavailable', { llm: LLM_NAMES[backend] }),
        };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: apiMessages.t('status.summaryPaused') };
    }
    return { tone: 'active', text: apiMessages.t('status.summaryRecording', { minutes: intervalMin }) };
}
