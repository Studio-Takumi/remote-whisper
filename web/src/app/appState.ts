// ストアの状態の形（画面が読む状態とアクションの入口。spec/api.md 7.1）
import type { StoreApi } from 'zustand';

import type { LiveSource, SettingsOptions } from '@/api/protocol';
import type { ServerStatus } from '@/api/status';
import type { ContextSelection, Generating, Project } from '@/api/types';
import type { MicState } from '@/features/recording/audio/microphone';
import type { UnsentElsewhere } from '@/features/recording/audio/unsentStore';
import type { Joined } from '@/features/recording/join';
import type { RecordingState } from '@/features/recording/recording';
import type { Watching } from '@/features/recording/watch';
import type { Correction } from '@/features/session/corrections';
import type { LiveDraft } from '@/features/session/liveMessages';
import type { LivePartial } from '@/features/session/livePartials';
import type { Settings } from '@/features/settings/settings';

export type Selection = { projectId: string | null; sessionId: string | null };

export type AppState = {
    projects: Project[];
    selection: Selection;
    recordingState: RecordingState;
    // 録音中のセッション。録音を始めたときに作る（spec/files.md 5.2・spec/flows.md 6.2）
    recordingSessionId: string | null;
    // 録音の経過時間（秒）。録音した音声の長さで、一時停止中は止まる
    elapsed: number;
    // マイクの音量（RMS、0〜1）。ボタンのアニメーションに使う
    micLevel: number;
    // 録音中のマイクの状態（止まっていないか。#102）
    micState: MicState;
    // 音は届いているのに、しばらく文字起こしが出ていない（サーバーが知らせる。#120）
    transcriptionStalled: boolean;
    // 送ったが ack がまだ来ていない音声のチャンクの数
    pendingAudio: number;
    // 文字起こし中の区間（partial）。final が来たら消える。音源が 2 つ以上なら音源ごとに 1 つ（#356）
    partials: LivePartial[];
    // 録音中のセッションに、この端末のマイクを音源として参加している（#241・#356）
    joined: Joined | null;
    // 参加する・抜ける
    joinSession: (sessionId: string) => Promise<void>;
    leaveSession: () => void;
    // 録音中のセッションの音源の一覧（sources のメッセージ。#357）。セッション ID ごと
    liveSources: Record<string, LiveSource[]>;
    // 届いている途中の途中の要約（summary.delta kind: live）。summary.done で session.liveSummary に移す
    liveDraft: LiveDraft | null;
    // ほかのクライアントで録音中のセッションを見ている（#238）。開いているセッションが録音中で、
    // 自分で録音していなければ、サーバーに watch を送って見る
    watching: Watching | null;
    settings: Settings;
    // サーバーから設定を読めたか（#339）。読めるまでは settings が既定値なので、保存で上書きしないために見る
    settingsLoaded: boolean;
    // 設定で選べる値。サーバーから取れなければダミーのまま
    options: SettingsOptions;
    // サーバーのバージョン（コミットハッシュ）。取れていなければ null
    serverVersion: string | null;
    server: ServerStatus;
    // 参考資料セットの選択を保存するまでの間の、手元の選択（プロジェクトごと）。
    // 参考資料セットの一覧はサーバーのデータなので、ここではなくキャッシュに置く（cachedContextSets）
    contextSelections: Record<string, ContextSelection>;
    generating: Generating | null;
    settingsOpen: boolean;
    // 設定モーダルで開いているページ（URL の /settings/<ページ>。#177）
    settingsPage: string;
    newProjectOpen: boolean;
    // プロジェクトの一覧を一度でも読み込めたか（URL から開くセッションを探せるか。#177）
    projectsLoaded: boolean;
    // URL のセッション・プロジェクトが見つからない（消えた・保存期間を過ぎた。#177）
    notFound: boolean;
    // アップロード中の音声ファイル（#180）。percent は 0〜100
    uploading: { projectId: string; name: string; percent: number } | null;
    // 音声ファイルから新しいセッションを作る。終わったら、そのセッションを開く
    uploadAudio: (projectId: string, file: File) => Promise<void>;
    // 選んだ（ドロップした）音声ファイル。複数なら、まとめるか別々にするかを選ぶまで持つ（#357）
    pickedAudio: { projectId: string; files: File[] } | null;
    pickAudioFiles: (projectId: string, files: File[]) => void;
    cancelPickedAudio: () => void;
    // 選んだファイルを別々のセッションにする
    uploadSeparately: () => Promise<void>;
    // 選んだファイルを 1 つのセッションの音源にまとめる（#241・#357）。main は主の音源にするファイルの番号
    uploadSources: (main: number) => Promise<void>;
    // 開発用パネルで、プロジェクトが 0 件の状態を確かめるためのもの
    noProjects: boolean;

    loadOptions: () => Promise<void>;
    loadSettings: () => Promise<void>;
    // プロジェクトとセッションの一覧を取り直す
    loadProjects: () => Promise<void>;
    // ディレクトリをプロジェクトとして登録する（POST /api/projects）
    createProject: (path: string) => Promise<void>;
    selectSession: (projectId: string, sessionId: string) => void;
    newSession: (projectId: string) => void;
    // 録音中に別のセッションを開いていたら、録音中のセッションに戻る（#133）
    showRecordingSession: () => void;
    startRecording: () => Promise<void>;
    // 途中で終わったセッションの続きを、同じセッションのまま録音する（#101）
    continueRecording: (sessionId: string) => Promise<void>;
    // 止まったマイクを開き直す（録音はそのまま続ける。#102）
    reopenMicrophone: () => Promise<void>;
    // 拾った語を消す（誤った語。以後そのセッションでは足さない。#103）。手で足した語は外すだけ（#175）
    rejectTerm: (sessionId: string, term: string) => Promise<void>;
    // 用語リストに手で語を足す（#175）。足せたら true
    addTerm: (sessionId: string, term: string) => Promise<boolean>;
    // セッションを別のプロジェクトへ移す（#172）
    moveSession: (fromProjectId: string, sessionId: string, toProjectId: string) => Promise<void>;
    // サイドバーのプロジェクトを並び替える（#173）。ids は新しい並び。サーバーに保存し、ほかの端末にも反映される
    reorderProjects: (ids: string[]) => Promise<void>;
    // 文字起こしの置き換えを足す（#176）。正しい語は手で足した語にも入る。足せたら true
    addCorrection: (sessionId: string, correction: Correction) => Promise<boolean>;
    // 置き換えを外す（以後は当たらない）
    removeCorrection: (sessionId: string, correction: Correction) => Promise<void>;
    // ページを読み込み直す前に、サーバーに届かなかった音声（IndexedDB に置いてあったもの。#102）
    unsent: { sessionId: string; projectId: string; seconds: number } | null;
    // 届かなかった音声を送り、同じセッションの続きを録音する
    recoverUnsent: () => Promise<void>;
    // 届かなかった音声を捨てる
    discardUnsent: () => Promise<void>;
    // ほかのホストで録音していて、届かなかった音声（クラウド版。#227）。そのホストにつないだときに復旧する。
    // host が null は、どのホストのものか分からないもの（復旧しない）
    unsentElsewhere: UnsentElsewhere[];
    // ほかのホストの届かなかった音声を捨てる（外したホストと、どのホストのものか分からないもの）
    discardUnsentElsewhere: (hosts: (string | null)[]) => Promise<void>;
    pauseRecording: () => Promise<void>;
    resumeRecording: () => void;
    stopRecording: () => Promise<void>;
    // マイクの許可の状態を見張り始める
    watchMicrophone: () => void;
    // サーバーにつなぎ、状態の通知を受け取り始める
    connectServer: () => void;
    changeSettings: (settings: Settings) => Promise<boolean>;
    // 今の全体設定（全体概要と要約詳細のモデル）で、最終の要約を作り直す（POST .../summaries）
    regenerateSummary: (sessionId: string) => Promise<void>;
    // 最終の文字起こしを今の全体設定で作り直す・表示する世代を選ぶ（#124）
    regenerateFinalTranscript: (sessionId: string) => Promise<void>;
    showFinalTranscript: (sessionId: string, generationId: string) => Promise<void>;
    changeContextSelection: (selection: ContextSelection) => Promise<void>;
    createContextSet: (materials: string[]) => Promise<void>;
    setServer: (server: ServerStatus) => void;
    setSettingsOpen: (open: boolean) => void;
    setSettingsPage: (page: string) => void;
    setNewProjectOpen: (open: boolean) => void;
    setNoProjects: (noProjects: boolean) => void;
};

// ストアの外のモジュール（録音・WebSocket の受け取り）に渡す、ストアの読み書き
export type AppStore = Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>;
