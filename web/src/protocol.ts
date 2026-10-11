// WebSocket /ws でやりとりするメッセージ（docs/spec.md 7.2 節）。サーバーの server/src/remote_whisper/routes/ws.py と合わせる

// ブラウザ → サーバー（制御）。音声はバイナリで、先頭4バイトが連番（uint32 LE）、続きが 16kHz・モノラル・Int16 の PCM
export type ClientMessage =
    | { type: 'start'; project: string }
    | { type: 'stop' }
    | { type: 'pause' }
    | { type: 'unpause' }
    // 再接続のためのもの。一時停止からの再開は unpause
    | { type: 'resume'; session: string; nextSeq: number };

export type SummaryKind = 'live' | 'final';

// GPU キューのジョブ（status の jobs。spec 6.3・7.2）。秒数はサーバーが送った時点のもの
export type GpuJobKind = 'transcribe' | 'whisperLoad' | 'liveSummary' | 'finalSummary' | 'contextSet' | 'other';
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
    | { type: 'started'; session: string; resumed?: boolean }
    // ここまでの音声を手元のバッファから消してよい
    | { type: 'ack'; session: string; seq: number }
    | { type: 'partial'; session: string; segment: number; committed: string; tentative: string }
    // start・end は録音の開始からの秒数
    | { type: 'final'; session: string; segment: number; start: number; end: number; text: string }
    | { type: 'summary.delta'; session: string; kind: SummaryKind; text: string }
    | { type: 'summary.done'; session: string; kind: SummaryKind }
    | { type: 'title'; session: string; title: string; provisional: boolean }
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
      }
    | { type: 'error'; session?: string; code: ErrorCode; message: string };

export type ErrorCode =
    | 'bad_message'
    | 'not_available'
    | 'not_recording'
    | 'already_recording'
    | 'too_many_recordings'
    | 'session_not_found'
    | 'project_not_found'
    | 'write_failed'
    | 'ollama_unavailable'
    | 'summary_skipped';

// GET /api/settings/options
export type SettingsOptions = {
    whisper: { models: string[]; computeTypes: string[] };
    ollama: { models: { name: string; thinking: boolean }[] };
};
