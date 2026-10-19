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
    // 録音後に録音全体から作る最終の文字起こし（#121）
    | 'finalTranscript'
    // 録音のあとに、今回扱った資料の範囲で参考資料を作り直す（#182）
    | 'materialRange'
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
    // sessionUuid は新しく始めたセッションの、画面の URL に出す ID（#177。古いサーバーにはない）
    | {
          type: 'started';
          session: string;
          sessionUuid?: string | null;
          resumed?: boolean;
          continued?: boolean;
          offsetSec?: number;
      }
    // ここまでの音声を手元のバッファから消してよい
    | { type: 'ack'; session: string; seq: number }
    | { type: 'partial'; session: string; segment: number; committed: string; tentative: string }
    // start・end は録音の開始からの秒数
    | { type: 'final'; session: string; segment: number; start: number; end: number; text: string }
    // 最終の文字起こしができた（#121。全員に送る）
    | { type: 'finalTranscript'; session: string; generationId: string }
    // 音は届いているのに文字起こしが出ていない（stalled: true）・また出るようになった（false）。#120
    | { type: 'transcriptionStalled'; session: string; stalled: boolean }
    // replace は、届いている下書きをこの text で置き換える（途中の要約の前置きと、できあがった全体。#123）
    | { type: 'summary.delta'; session: string; kind: SummaryKind; text: string; replace?: boolean }
    | { type: 'summary.done'; session: string; kind: SummaryKind }
    | { type: 'title'; session: string; title: string; provisional: boolean }
    // 録音中に文字起こしから拾って用語リストに足した語と、消された語（#103）
    | { type: 'terms'; session: string; terms: string[]; rejected: string[]; manual?: string[] }
    // セッションを別のプロジェクトへ移した（#172。全員に送る）。from・to はプロジェクト ID
    | { type: 'sessionMoved'; session: string; sessionUuid: string | null; from: string; to: string }
    // プロジェクトの並び順が変わった（#173。全員に送る）。一覧と設定を取り直す
    | { type: 'projectOrder' }
    // 置き換え（#176）を足した・外した。そのセッションの文字起こしを取り直す
    | { type: 'corrections'; session: string }
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
          // 最終の文字起こしを作っているセッション（録音が終わるのを待っている間も含む）。#124
          transcribing?: string[];
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
    | 'summary_failed'
    // 最終の文字起こしを作り直せなかった（#124）
    | 'final_transcript_failed';

// GET /api/settings/options
export type SettingsOptions = {
    // finalTranscript は、最終の文字起こし（WhisperX）を作れるサーバーか（#124。古いサーバーにはない）
    whisper: { models: string[]; computeTypes: string[]; finalTranscript?: boolean };
    // missing は、処理ごとのモデル（#178）のうち Ollama に入っていないもの（ollama.models のキー）
    ollama: { models: { name: string; thinking: boolean }[]; missing?: string[] };
};
