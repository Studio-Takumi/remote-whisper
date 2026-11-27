// WebSocket /ws でやりとりするメッセージ（docs/spec/api.md 7.2 節）。サーバーの server/src/remote_whisper/routes/ws.py と合わせる
import type { LlmBackend, TranscriptionLanguage } from '@/features/settings/settings';
import type { Language } from '@/i18n/language';

// ブラウザ → サーバー（制御）。音声はバイナリで、先頭4バイトが連番（uint32 LE）、続きが 16kHz・モノラル・Int16 の PCM
export type ClientMessage =
    // language は今回だけ変えた文字起こしの言語（#482）。省くと全体設定。displayLanguage はこの端末の表示言語（#498）
    | { type: 'start'; project: string; language?: TranscriptionLanguage; displayLanguage?: Language }
    | { type: 'stop' }
    | { type: 'pause' }
    | { type: 'unpause' }
    // 再接続のためのもの。一時停止からの再開は unpause
    | { type: 'resume'; session: string; nextSeq: number }
    // 途中で終わった（interrupted）セッションの続きを、同じセッションのまま録音する（#101）
    | { type: 'continue'; project: string; session: string }
    // 録音していたページが閉じられたセッションを、つなぎ直すのを待たずに途中で終わったことにする（#448）
    | { type: 'interrupt'; session: string }
    // ほかのクライアントで録音中のセッションを見る・見るのをやめる（#238）。見るのは 1 つだけ
    | { type: 'watch'; session: string }
    | { type: 'unwatch' }
    // 録音中のセッションに音源として参加する・抜ける（#241・#356）。source・nextSeq は切れたあとのつなぎ直し
    | { type: 'join'; session: string; name: string }
    // lost は、読み込み直して手元の音をなくした（サーバーが届かなかった間を無音で埋め、nextSeq から受け取る）
    | { type: 'join'; session: string; source: number; nextSeq: number; lost?: boolean }
    | { type: 'leave' };

// 録音中のセッションに参加できるか（#241・#356）。参加に対応していない古いサーバーは送らない
export type JoinAvailability = { available: boolean; reason?: 'limit' | 'disabled' };
// 音源の一覧（sources）。state は active（つながっている）・disconnected（切れている）・left（抜けた）
export type LiveSource = {
    id: number;
    name: string | null;
    kind: 'main' | 'join' | 'upload';
    state: 'active' | 'disconnected' | 'left';
};

export type SummaryKind = 'live' | 'final';

// 見ている側に出す録音の状態（#238）。disconnected は録音しているクライアントとの接続が切れていて、
// つなぎ直すのを待っている間。stopped は録音を終えた
export type WatchedState = 'recording' | 'paused' | 'disconnected' | 'stopped';

// GPU キューのジョブ（status の jobs。spec/flows.md 6.3・spec/api.md 7.2）。秒数はサーバーが送った時点のもの
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
// 実行中のジョブの進み具合（#340）。浄書と最終要約だけ。古いサーバー・ほかのジョブでは来ない
// step は段階の名前、done・total は済んだ数と全体の数（分かるときだけ）、percent は段階の中の %（分かるときだけ）
export type GpuJobProgress = { step: string; done?: number; total?: number; percent?: number };
export type GpuJobs = {
    running: {
        kind: GpuJobKind;
        session: string | null;
        runningSec: number;
        progress?: GpuJobProgress;
    } | null;
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
    // resumed・continued・offsetSec・sessionUuid の意味は spec/api.md 7.2
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
    // source は音源 ID（音源が 2 つ以上のセッションだけ。#356）。segment は音源をまたいだ通し番号
    | {
          type: 'partial';
          session: string;
          segment: number;
          committed: string;
          tentative: string;
          source?: number;
      }
    // start・end は録音の開始からの秒数
    | {
          type: 'final';
          session: string;
          segment: number;
          start: number;
          end: number;
          text: string;
          source?: number;
      }
    // join の返事（#356）。offsetSec は主の音源の時刻での参加した時刻。rejoined はつなぎ直し（続けて ack が届く）
    | { type: 'joined'; session: string; source: number; offsetSec: number; rejoined?: boolean }
    // 音源の一覧が変わった（#356）
    | { type: 'sources'; session: string; sources: LiveSource[]; join: JoinAvailability }
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
    // ホストのアップデートの確認の結果が変わった（#472。全員に送る）。GET /api/version を取り直す
    | { type: 'version' }
    // 置き換え（#176）を足した・外した。そのセッションの文字起こしを取り直す
    | { type: 'corrections'; session: string }
    | { type: 'contextSet'; project: string; id: string; status: ContextSetStatus }
    // watch の返事（#238）。idle なら録音中ではないので見ない。そうでなければ、そこまでの
    // 文字起こし・リアルタイム要約・タイトルが付いていて、このあとセッションのメッセージが届く
    | {
          type: 'watching';
          session: string;
          state: WatchedState | 'idle';
          transcript?: { time: string; text: string; source?: number }[];
          liveSummary?: string | null;
          title?: string | null;
          // 参加に対応したサーバーだけ（#356）
          join?: JoinAvailability;
      }
    // 見ているセッションの録音の状態が変わった（#238）
    | { type: 'recordingState'; session: string; state: WatchedState }
    // interrupt の返事（#448）。interrupted は終わりにした、connected はほかの接続が録音している、
    // notRecording は録音中でない（もう終わっていた）
    | { type: 'interrupted'; session: string; result: 'interrupted' | 'connected' | 'notRecording' }
    | {
          type: 'status';
          whisper: WhisperState;
          ollama: OllamaState;
          // LM Studio（#324）。一度も使っていなければ来ない
          lmstudio?: OllamaState;
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
    // message は表示する文（届いたときに messageCode・params から表示言語で引き直す。#494）。
    // messageCode・params は古いサーバーにはない
    | {
          type: 'error';
          session?: string;
          code: ErrorCode;
          message: string;
          messageCode?: string;
          params?: Record<string, string | number>;
      };

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
    // LM Studio につながらない（#324）。扱いは ollama_unavailable と同じ
    | 'lmstudio_unavailable'
    | 'summary_skipped'
    // 最終の要約を作る途中で、思わぬエラーになった
    | 'summary_failed'
    // 最終の文字起こしを作り直せなかった（#124）
    | 'final_transcript_failed'
    // 録音中のセッションに参加できない（#356）
    | 'cannot_join';

// GET /api/settings/options
export type SettingsOptions = {
    // finalTranscript は、最終の文字起こし（WhisperX）を作れるサーバーか（#124。古いサーバーにはない）
    whisper: { models: string[]; computeTypes: string[]; finalTranscript?: boolean };
    // 使っている LLM（Ollama か LM Studio。#325・#327）のモデル。録音中に llm.backend を変えたときは、
    // 切り替わるまで前のもの。missing は、処理ごとのモデル（#178）のうち、そのバックエンドに入っていないもののキー
    llm: { backend: LlmBackend; models: { name: string; thinking: boolean }[]; missing?: string[] };
    // 複数の音源に対応しているサーバーだけが返す（#241）。maxSources はまとめられるファイルの数の上限
    recording?: { maxSources: number };
};
