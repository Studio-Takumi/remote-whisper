import { defineDictionary } from '@/i18n/messages';

// アプリの枠（app/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // App.tsx
    'app.settingsSaved': '設定を保存しました',

    // AppSidebar.tsx
    'appSidebar.account': 'アカウント',
    'appSidebar.newProject': '新規プロジェクト作成',
    'appSidebar.settings': '設定',

    // DevPanel.tsx
    'devPanel.connection': '接続',
    'devPanel.emptyProjects': 'プロジェクトを空にする',
    'devPanel.microphone': 'マイク',
    'devPanel.panel': '開発用パネル',
    'devPanel.title': '開発用',

    // GpuIndicator.tsx
    'gpuIndicator.waiting': '待ち {count}',

    // GpuJobList.tsx
    'gpuJobList.elapsed': '{time} 経過',
    'gpuJobList.none': 'なし',
    'gpuJobList.note': 'GPU は 1 つずつ順に使います。要約を作っている間は、文字起こしが待たされます',
    'gpuJobList.running': '実行中',
    'gpuJobList.unavailable': '使用率は取れません（NVIDIA の GPU がないなど）',
    'gpuJobList.usage': '使用率 {util}% ・ VRAM {used} / {total} GB',
    'gpuJobList.waited': '{time} 待ち',
    'gpuJobList.waiting': '待っている（実行する順）',

    // GpuJobRow.tsx
    'gpuJobRow.detail': '{progress}、{time}',
    'gpuJobRow.notFound': '（見つかりません）',
    'gpuJobRow.open': '{kind}のセッション「{title}」を開く（{detail}）',
    'gpuJobRow.progress': '{kind}の進み具合',

    // gpuJobs.ts
    'gpuJobs.detailSeparator': '、',
    'gpuJobs.trigger': 'GPU の状態とジョブの一覧',
    'gpuJobs.triggerWithDetails': 'GPU の状態とジョブの一覧（{details}）',
    'gpuJobs.usage': '使用率 {util}%',
    'gpuJobs.waiting': '待ち {count} 件',

    // HostUpdateNotice.tsx
    'hostUpdateNotice.available': '{version} が出ています',
    'hostUpdateNotice.description': 'ホストを更新すると使えます',
    'hostUpdateNotice.releaseNotes': 'リリースノート',

    // PwaUpdater.tsx
    'pwaUpdater.preloadError': '画面の一部を読み込めません（ホストが新しいバージョンになりました）',
    'pwaUpdater.preloadErrorHint': '読み込み直すと直ります',
    'pwaUpdater.reload': '読み込み直す',
    'pwaUpdater.update': '更新',
    'pwaUpdater.updateAfterRecording': '録音を終えてから更新してください',
    'pwaUpdater.updateAvailable': '新しいバージョンの画面があります',
    'pwaUpdater.updateReloads': '更新すると、読み込み直します',

    // serverMessages.ts
    'serverMessages.contextSetCreated': '参考資料ができました',
    'serverMessages.contextSetFailed': '参考資料を作れませんでした（資料を読めないか、{llm} に接続できません）',

    // sessionSync.ts
    'sessionSync.loadFailed': 'セッションを読み込めません: {error}',
    'sessionSync.polishRegenerated': '浄書済み文字起こしを再生成しました',
    'sessionSync.regenerateSummary': '要約も再生成する',

    // TopBar.tsx
    'topBar.hostLocked': '録音中はホストを切り替えられません',
    'topBar.menuOpen': 'メニューを開く',
    'topBar.model': 'モデル',
    'topBar.modelSettings': 'モデルの設定を開く（{model}）',
});
