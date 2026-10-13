// 画面で扱うデータの形。サーバーの API（spec 7.1）から作る
import type { SessionFiles } from '@/api';

export type TranscriptLine = {
    time: string;
    text: string;
};

// 最終の要約。作り直すたびに増えていく（spec 6.5 節）
export type Summary = {
    generationId: string;
    model: string;
    generatedAt: string;
    // 本文。まだ取ってきていなければない
    text?: string;
};

// 最終の文字起こし（#121）。行は文ごと。話者を分けたときは、本文が「話者 1: …」で始まる
export type FinalTranscript = {
    generationId: string;
    model: string;
    generatedAt: string;
    // 話者分け。done は分けた、off は設定で切っていた、unavailable はモデルを使えなかった
    diarization: 'done' | 'off' | 'unavailable';
    speakers: number;
    lines: TranscriptLine[];
};

export type Session = {
    id: string;
    title: string;
    startedAt: string;
    // 録音を終えた日時。録音中はない
    endedAt?: string;
    // 録音の長さ（秒）。録音中と、これを記録する前のセッションにはない
    durationSec?: number;
    // recording は録音中（ほかの端末で録音しているものも含む）
    status: 'recording' | 'done' | 'interrupted';
    // どのファイルが残っているか（サーバーから取ったとき）。保存期間を過ぎて消えたものは「期限切れ」と出す
    files?: SessionFiles;
    // 文字起こしと要約を取ってきたか。取るのはセッションを開いたとき
    loaded?: boolean;
    transcript: TranscriptLine[];
    // 録音後に録音全体から作った最終の文字起こし（#121）。いちばん新しい世代。なければない
    finalTranscript?: FinalTranscript;
    summaries: Summary[];
    // 途中の要約（いちばん新しいもの）。最終の要約がまだないときに代わりに出す
    liveSummary?: string;
    // タイトルが仮のもの（途中の要約から作ったもの）かどうか
    provisionalTitle?: boolean;
    // 最終の要約を作れなかった（Ollama につながらなかったなど）。作り直して作れたら false
    summaryFailed?: boolean;
    // 録音中に文字起こしから拾って、用語リストに足した語（#103）
    pickedTerms?: string[];
};

export type Project = {
    id: string;
    name: string;
    path: string;
    sessions: Session[];
    // サーバーに保存されている、今選んでいる参考資料セット（spec 5.4 節の selection）
    selection?: ContextSelection;
};

// 作成中の最終の要約。summary.delta（spec 7.2 節）で届いた分
export type Generating = { sessionId: string; model: string; text: string };

// 参考資料セット（spec 5.4 節の contextSets）。/api/projects/{pid}/context-sets から取る
export type ContextSet = {
    id: string;
    status: 'generating' | 'ready' | 'failed';
    materials: string[];
};

// プロジェクトで今選んでいる状態（spec 5.4 節の selection）
export type ContextSelection = {
    setId: string | null;
    useHotwords: boolean;
    useContext: boolean;
    // 録音中に文字起こしから用語を拾い、用語リストに足すか（#103）
    pickTerms: boolean;
};

// 資料のファイル名だけを並べた、セットの表示名
export function contextSetName(set: ContextSet) {
    return set.materials.map((m) => m.split(/[\\/]/).at(-1)).join(', ');
}
