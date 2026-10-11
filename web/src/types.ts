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

export type Session = {
    id: string;
    title: string;
    startedAt: string;
    // 録音を終えた日時。録音中はない
    endedAt?: string;
    // 録音の長さ（秒）。録音中はない
    durationSec?: number;
    // recording は録音中（ほかの端末で録音しているものも含む）
    status: 'recording' | 'done' | 'interrupted';
    // どのファイルが残っているか（サーバーから取ったとき）。保存期間を過ぎて消えたものは「期限切れ」と出す
    files?: SessionFiles;
    // 文字起こしと要約を取ってきたか。取るのはセッションを開いたとき
    loaded?: boolean;
    transcript: TranscriptLine[];
    summaries: Summary[];
    // 途中の要約（いちばん新しいもの）。最終の要約がまだないときに代わりに出す
    liveSummary?: string;
    // タイトルが仮のもの（途中の要約から作ったもの）かどうか
    provisionalTitle?: boolean;
    // 最終の要約を作れなかった（Ollama につながらなかったなど）。作り直して作れたら false
    summaryFailed?: boolean;
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
};

// 資料のファイル名だけを並べた、セットの表示名
export function contextSetName(set: ContextSet) {
    return set.materials.map((m) => m.split(/[\\/]/).at(-1)).join(', ');
}
