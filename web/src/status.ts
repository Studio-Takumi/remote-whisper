import type { GpuJobKind, GpuJobs, GpuStats } from '@/protocol';
import type { RecordingState } from '@/recording';

// サーバーとブラウザの状態。whisper・ollama・jobs・gpu は WebSocket の status メッセージ（spec 7.2 節）から、
// connection は WebSocket がつながっているか、microphone はマイクの許可から、ブラウザ側で決める
export type ServerStatus = {
    whisper: 'unloaded' | 'loading' | 'ready' | 'error';
    ollama: 'ready' | 'error';
    connection: 'connected' | 'reconnecting';
    microphone: 'granted' | 'denied';
    jobs: GpuJobs;
    // jobs を受け取った時刻（Date.now()）。経過時間を数え足すのに使う
    jobsAt: number;
    gpu: GpuStats | null;
    // 最終の文字起こしを作っているセッション（#124）
    transcribing: string[];
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
};

// GPU キューのジョブの種類の名前
export const jobKindLabel: Record<GpuJobKind, string> = {
    transcribe: '文字起こし',
    whisperLoad: '文字起こしのモデルの読み込み',
    liveSummary: '途中の要約',
    finalSummary: '最終の要約',
    contextSet: '参考資料セットの作成',
    terms: '文字起こしからの用語の抽出',
    finalTranscript: '最終の文字起こし',
    other: 'その他',
};

// 文字起こしを待たせている理由
const blockingReason: Partial<Record<GpuJobKind, string>> = {
    liveSummary: '途中の要約の生成中',
    finalSummary: '最終の要約の生成中',
    contextSet: '参考資料セットの作成中',
    terms: '用語の抽出中',
    finalTranscript: '最終の文字起こしの作成中',
};

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
            ? { tone: 'warning', text: 'サーバーにつながっていません。つなぎ直しています…' }
            : { tone: 'idle', text: '待機中' };
    }
    if (server.connection === 'reconnecting') {
        // つながり直せば、そのまま続く。待つ時間を過ぎても、あとで同じセッションの続きを録音できる（#101）
        return {
            tone: 'warning',
            text: 'サーバーに再接続しています…（録音は手元で続けています。つながれば、そのまま続きます）',
        };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: '一時停止中' };
    }
    if (server.whisper === 'error') {
        return { tone: 'error', text: '文字起こしが止まっています。音声は保存しているので、後から作り直せます' };
    }
    // GPU は1つずつしか使えず、実行中の要約は途中で止めないので、終わるまで文字起こしが待たされる（spec 6.3）
    // モデルの読み込みもその後ろで待つので、読み込み中の表示より先に見る
    const blocking = transcriptWaitingFor(server.jobs, sessionId);
    if (blocking) {
        return {
            tone: 'warning',
            text: `${blockingReason[blocking] ?? 'ほかの処理'}のため、文字起こしを待っています…（終わったら続きを出します。音声は保存しています）`,
        };
    }
    if (server.whisper !== 'ready') {
        return { tone: 'warning', text: '文字起こしのモデルを読み込んでいます…（音声は保存しています）' };
    }
    return { tone: 'active', text: '文字起こし中…' };
}

// 要約タブ用。録音していないときは出さない
export function summaryStatus(state: RecordingState, server: ServerStatus, intervalMin: number): Status | null {
    if (state === 'idle') {
        return null;
    }
    if (server.connection === 'reconnecting') {
        return { tone: 'warning', text: 'サーバーに再接続しています…（録音は続けています）' };
    }
    if (server.ollama === 'error') {
        return { tone: 'error', text: 'Ollama に接続できないため、要約を作れません。録音が終わった後に作り直せます' };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: '一時停止中。再開すると要約の更新も再開します' };
    }
    return { tone: 'active', text: `録音中。${intervalMin} 分おきに途中の要約を更新します…` };
}
