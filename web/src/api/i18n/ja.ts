import { defineDictionary } from '@/i18n/messages';

// API・状態（api/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）。
// サーバーのエラーの文は api/serverErrors/i18n/ にある
export const ja = defineDictionary({
    // 2 つ以上のファイルで使う文
    'common.hostUnreachable': 'ホストにつながりません',

    // connection.ts
    'connection.noResponse': 'ホストから応答がありません',

    // endpoint.ts
    'endpoint.noHost': 'ホストが選ばれていません',

    // sessions.ts
    'sessions.newSession': '新しいセッション',

    // status.ts
    'status.blockedByFinalSummary': '最終要約の生成中',
    'status.blockedByLiveSummary': 'リアルタイム要約の生成中',
    'status.blockedByMaterialRange': '参考資料の再生成中',
    'status.blockedByOther': 'ほかの処理',
    'status.blockedByPolish': '浄書中',
    'status.blockedByReferenceMaterials': '参考資料の作成中',
    'status.blockedByTerms': '用語抽出中',
    'status.jobKindFinalSummary': '最終要約',
    'status.jobKindLiveSummary': 'リアルタイム要約',
    'status.jobKindMaterialRange': '扱った範囲での参考資料の再生成',
    'status.jobKindOther': 'その他',
    'status.jobKindPolish': '文字起こしの浄書',
    'status.jobKindReferenceMaterials': '参考資料の作成',
    'status.jobKindTerms': '文字起こしからの用語抽出',
    'status.jobKindTranscribe': '文字起こし',
    'status.jobKindTranscriptModelLoad': '文字起こしのモデル読み込み',
    'status.stepAlign': '位置合わせ',
    'status.stepCondense': '要約詳細のまとめ',
    'status.stepDetailedSummary': '要約詳細',
    'status.stepLoad': 'モデルの読み込み',
    'status.stepOverview': '全体概要',
    'status.stepPages': '参考資料のページ付け',
    'status.stepSpeakerLabeling': '話者分け',
    'status.stepSummary': '要約',
    'status.stepTitle': 'タイトル',
    'status.stepTranscribe': '文字起こし',
    'status.summaryLlmUnavailable': '{llm} に接続できず、要約を作れません。録音を終えてから再生成できます',
    'status.summaryPaused': '一時停止中。再開すると要約の更新も再開します',
    'status.summaryReconnecting': 'ホストに再接続しています…（録音は続けています）',
    'status.summaryRecording': '録音中。{minutes} 分おきにリアルタイム要約を更新します…',
    'status.transcriptIdle': '待機中',
    'status.transcriptIdleReconnecting': 'ホストにつながっていません。つなぎ直しています…',
    'status.transcriptLoadingModel': '文字起こしのモデルを読み込んでいます…（音声は保存しています）',
    'status.transcriptPaused': '一時停止中',
    'status.transcriptReconnecting': 'ホストに再接続しています…（録音は手元で続けています）',
    'status.transcriptRunning': '文字起こし中…',
    'status.transcriptStopped': '文字起こしが止まっています。音声は保存しているので、後から再生成できます',
    'status.transcriptWaiting': '{reason}のため、文字起こしを待っています…（音声は保存しています）',
});
