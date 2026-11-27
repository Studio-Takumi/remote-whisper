import { defineDictionary } from '@/i18n/messages';

// プロジェクト（features/projects/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // loadProjects.ts
    'loadProjects.failed': 'プロジェクトを読み込めません: {error}',

    // move.ts
    'move.blockedByGpu': 'GPU の処理を待っている・実行しているセッションは移せません',
    'move.blockedByPolish': '浄書済み文字起こしを作っている途中のセッションは移せません',
    'move.blockedByRecording': '録音中のセッションは移せません',
    'move.blockedBySummary': '要約を作っている途中のセッションは移せません',

    // NewProjectDialog.tsx
    'newProjectDialog.cancel': 'キャンセル',
    'newProjectDialog.chooseFolder': 'フォルダを選んでください',
    'newProjectDialog.create': 'このフォルダで作成',
    'newProjectDialog.description':
        'プロジェクトにするフォルダを選んでください。最終要約のコピーはこのフォルダに置かれます',
    'newProjectDialog.listFailed': 'フォルダの一覧を取れません: {error}',
    'newProjectDialog.loading': '読み込んでいます…',
    'newProjectDialog.noFolders': '読み込めるフォルダがありません。設定の「参考資料」で追加してください',
    'newProjectDialog.title': '新規プロジェクト作成',

    // projectActions.ts
    'projectActions.createFailed': 'プロジェクトにできません: {error}',
    'projectActions.created': '{path} をプロジェクトにしました',
    'projectActions.moveFailed': '「{title}」を移せません: {error}',
    'projectActions.moved': '「{title}」を{project}へ移しました',
    'projectActions.reorderFailed': 'プロジェクトの並びを保存できません: {error}',

    // ProjectGroup.tsx
    'projectGroup.newSession': '{name}で新しく録音',
    'projectGroup.reorder': '{name}の並び順を変える',

    // ProjectList.tsx
    'projectList.dragCancel': '「{name}」の移動をやめました',
    'projectList.dragEndDropped': '「{name}」を「{over}」の位置に置きました',
    'projectList.dragEndReturned': '「{name}」を戻しました',
    'projectList.dragOver': '「{name}」を「{over}」の位置に動かしています',
    'projectList.dragStart': '「{name}」を持ち上げました',
    'projectList.empty': 'プロジェクトはまだありません',
    'projectList.screenReaderInstructions':
        'プロジェクトの並び順は、Space で持ち上げ、上下の矢印で動かし、Space で置きます。Esc でやめます',

    // SessionItem.tsx
    'sessionItem.fromAudioFile': '音声ファイルから作成',
    'sessionItem.recording': '録音中',

    // sessionMeta.ts
    'sessionMeta.recording': '{started} · 録音中',
});
