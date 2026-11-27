import { defineDictionary } from '@/i18n/messages';

// 参考資料（features/materials/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // contextSetActions.ts
    'contextSetActions.createFailed': '参考資料を作れません: {error}',
    'contextSetActions.created': '参考資料ができました',
    'contextSetActions.lockedWhileRecording': '録音中は参考資料を変えられません',
    'contextSetActions.reused': '同じ資料の参考資料があるので、それを使います',
    'contextSetActions.selectionFailed': '参考資料の選択を保存できません: {error}',

    // ContextSetSheet.tsx
    'contextSetSheet.createNew': '資料を選んで新しく作る',
    'contextSetSheet.description':
        '選んだ資料から用語リストとコンテキストを作り、文字起こしと要約に使います（プロジェクトごと）',
    'contextSetSheet.generating': '作成中です。録音を始めても、できた時点から使います',
    'contextSetSheet.none': 'なし',
    'contextSetSheet.pickTerms': '録音中に用語を拾う',
    'contextSetSheet.pickTermsDescription': '文字起こしに何度も出てくる固有名詞・専門用語を、用語リストに足す',
    'contextSetSheet.pickTermsOff': '設定（要約）でオフになっています',
    'contextSetSheet.project': 'プロジェクト：{name}',
    'contextSetSheet.selectProject': '先にメニューからプロジェクトを選んでください',
    'contextSetSheet.statusFailed': '（失敗）',
    'contextSetSheet.statusGenerating': '（作成中…）',
    'contextSetSheet.title': '参考資料',
    'contextSetSheet.unused': '使わない',
    'contextSetSheet.useContext': 'コンテキストを使う',
    'contextSetSheet.useHotwords': '用語リストを使う',

    // MaterialPickerDialog.tsx
    'materialPickerDialog.cancel': 'キャンセル',
    'materialPickerDialog.create': 'この資料で作成',
    'materialPickerDialog.description': '選んだ資料から用語リストとコンテキストを作ります（数分かかります）',
    'materialPickerDialog.extensions': '読み込める拡張子：{extensions}',
    'materialPickerDialog.listFailed': 'フォルダの一覧を取れません: {error}',
    'materialPickerDialog.loading': '読み込んでいます…',
    'materialPickerDialog.noFolders': '読み込めるフォルダがありません。設定の「参考資料」で追加してください',
    'materialPickerDialog.selected': '{count} 件選択中',
    'materialPickerDialog.title': '参考資料を選ぶ',

    // materialRange.ts
    'materialRange.file': '{file} の {spans} {unit}',
    'materialRange.page': 'ページ',
    'materialRange.partSeparator': '、',
    'materialRange.redone': '参考資料は、今回扱った範囲（{parts}）で作り直しました',
    'materialRange.section': '番目の区切り',
    'materialRange.span': '{from}〜{to}',
    'materialRange.spanSeparator': '・',

    // SummaryDirField.tsx
    'summaryDirField.hint': '選んだディレクトリからの相対パス',
    'summaryDirField.label': '最終要約のコピーの置き場所',
    'summaryDirField.placeholder': '空なら直下（例: summary）',
    'summaryDirField.save': '保存',
    'summaryDirField.saveFailed': '最終要約のコピーの置き場所を保存できません: {error}',
    'summaryDirField.saved': '最終要約のコピーの置き場所を保存しました',
});
