// WebSocket /ws でやりとりするメッセージ（docs/spec.md 7.2 節）。サーバーの server/src/remote_whisper/routes/ws.py と合わせる

// ブラウザ → サーバー（制御）。音声はバイナリで、先頭4バイトが連番（uint32 LE）、続きが 16kHz・モノラル・Int16 の PCM
export type ClientMessage =
    | { type: 'start'; project: string }
    | { type: 'stop' }
    | { type: 'pause' }
    | { type: 'unpause' }
    // 再接続のためのもの。一時停止からの再開は unpause
    | { type: 'resume'; session: string; nextSeq: number }
    // 途中で終わった（interrupted）セッションの続きを、同じセッションのまま録音する（#101）
    | { type: 'continue'; project: string; session: string };

export type SummaryKind = 'live' | 'final';

// GPU キューのジョブ（status の jobs。spec 6.3・7.2）。秒数はサーバーが送った時点のもの
export type GpuJobKind =
    | 'transcribe'
    | 'whisperLoad'
    | 'liveSummary'
    | 'finalSummary'
    | 'contextSet'
    // 録音中に文字起こしから用語を拾う（#103）
    | 'terms'
    | 'other';
export type GpuJobs = {
    running: { kind: GpuJobKind; session: string | null; runningSec: number } | null;
    // 実行する順。続けて並ぶ同じ種類・同じセッションのものは count にまとめてある
    waiting: { kind: GpuJobKind; session: string | null; count: number; waitingSec: number }[];
};
// GPU の使用率（%）と VRAM（MiB）。取れない環境では null
export type GpuStats = { util: number; memUsedMb: number; memTotalMb: number };
export type WhisperState = 'unloaded' | 'loading' | 'ready' | 'error';
export type OllamaState = 'ready' | 'error';
export type ContextSetStatus = 'generating' | 'ready' | 'failed';

// サーバー → ブラウザ。セッションに関係するものには session が付く
export type ServerMessage =
    // resumed は再接続（resume）で続きから録音するとき
    // continued・offsetSec は続きを録音するとき（offsetSec は前の録音の長さ。時刻はここから続く）
    | { type: 'started'; session: string; resumed?: boolean; continued?: boolean; offsetSec?: number }
    // ここまでの音声を手元のバッファから消してよい
    | { type: 'ack'; session: string; seq: number }
    | { type: 'partial'; session: string; segment: number; committed: string; tentative: string }
    // start・end は録音の開始からの秒数
    | { type: 'final'; session: string; segment: number; start: number; end: number; text: string }
    | { type: 'summary.delta'; session: string; kind: SummaryKind; text: string }
    | { type: 'summary.done'; session: string; kind: SummaryKind }
    | { type: 'title'; session: string; title: string; provisional: boolean }
    // 録音中に文字起こしから拾って用語リストに足した語と、消された語（#103）
    | { type: 'terms'; session: string; terms: string[]; rejected: string[] }
    | { type: 'contextSet'; project: string; id: string; status: ContextSetStatus }
    | {
          type: 'status';
          whisper: WhisperState;
          ollama: OllamaState;
          recordings: number;
          queue: number;
          // 古いサーバーにはない
          jobs?: GpuJobs;
          gpu?: GpuStats | null;
          // 最終の要約を作っているセッション（録音を終えてから要約ができるまでと、作り直し）。#118
          summarizing?: string[];
      }
    | { type: 'error'; session?: string; code: ErrorCode; message: string };

export type ErrorCode =
    | 'bad_message'
    | 'not_available'
    | 'not_recording'
    | 'already_recording'
    | 'too_many_recordings'
    | 'session_not_found'
    // 続きを録音できない（途中で終わったセッションではない・録音ファイルが残っていない）
    | 'cannot_continue'
    | 'project_not_found'
    | 'write_failed'
    | 'ollama_unavailable'
    | 'summary_skipped'
    // 最終の要約を作る途中で、思わぬエラーになった
    | 'summary_failed';

// GET /api/settings/options
export type SettingsOptions = {
    whisper: { models: string[]; computeTypes: string[] };
    ollama: { models: { name: string; thinking: boolean }[] };
};
