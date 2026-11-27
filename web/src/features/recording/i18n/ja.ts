import { defineDictionary } from '@/i18n/messages';

// 録音（features/recording/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // AudioUpload.tsx
    'audioUpload.cancel': 'キャンセル',
    'audioUpload.create': '作る',
    'audioUpload.dialogDescription': 'セッションの作り方を選んでください',
    'audioUpload.dialogTitle': '{n} 個の音声ファイル',
    'audioUpload.label': '音声ファイルから作る',
    'audioUpload.merge': '1 つのセッションにまとめる',
    'audioUpload.mergeHint': '同じ場を複数のマイクで録ったもの',
    'audioUpload.primarySource': '主の音源',
    'audioUpload.separate': '別々のセッションにする',
    'audioUpload.separateHint': 'ファイルごとに 1 つずつ作ります',
    'audioUpload.uploading': '{name} をアップロードしています… {percent}%',
    'audioUpload.way': 'セッションの作り方',

    // closedRecordings.ts
    'closedRecordings.interrupted':
        '閉じる前に録音していたセッションを、途中で終わりにしました。そこまでの録音は残っています',

    // continueWindow.ts
    'continueWindow.lessThanMinute': 'あと 1 分未満',
    'continueWindow.minutes': 'あと {n} 分',

    // join.ts
    'join.disabled': 'このホストでは参加できない設定です',
    'join.full': '参加できる音源の数に達しています',
    'join.lost': '参加が切れました。もう一度参加してください',
    'join.unsupported': 'このホストは参加に対応していません',

    // micAction.ts
    'micAction.backPaused': '「{title}」で一時停止中です。クリックで戻ります',
    'micAction.backRecording': '「{title}」で録音中です。クリックで戻ります',
    'micAction.chooseProjectHint': 'プロジェクトを選んでください',
    'micAction.continue': 'クリックして続きから録音（録音を終えてから {min} 分の間は、続きから録音できます。{left}）',
    'micAction.continueHint': '押すと続きから録音',
    'micAction.join': '{watched}です。クリックしてこの端末のマイクで参加',
    'micAction.joinHint': 'この端末のマイクで参加',
    'micAction.joined': '音源 {source} として参加中',
    'micAction.joining': '参加しています…',
    'micAction.leave': '{joined}。クリックして参加をやめる',
    'micAction.micDenied': 'マイクが許可されていません。ブラウザの設定でマイクを許可してください',
    'micAction.micDeniedHint': 'マイクが許可されていません',
    'micAction.newSession': 'クリックして「{project}」に新しいセッションを作成',
    'micAction.newSessionHint': '押すと新しいセッション',
    'micAction.notice': 'ほかの端末で録音中です。操作はその端末でしてください',
    'micAction.pause': 'クリックして一時停止',
    'micAction.reconnecting': 'ホストにつなぎ直しています',
    'micAction.resume': 'クリックして録音再開',
    'micAction.start': 'クリックして録音開始',
    'micAction.startHint': '押すと録音開始',
    'micAction.viewOnly': 'この端末では閲覧専用です',
    'micAction.watched': '{watched}です。{reason}',

    // MicAlert.tsx
    'micAlert.reopen': 'マイクを開き直す',

    // MicButton.tsx
    'micButton.joinedOther': 'ほかのセッションに参加しています',
    'micButton.stop': 'クリックして録音終了',
    'micButton.stopShort': '終了',

    // micMessages.ts
    'micMessages.ended': 'マイクが止まりました。録音されていません。「マイクを開き直す」を押してください',
    'micMessages.fallback': '選んだマイクが見つからないため、OS の既定のマイクで録音します',
    'micMessages.fallbackWithLabel': '選んだマイク（{label}）が見つからないため、OS の既定のマイクで録音します',
    'micMessages.muted': 'マイクの音が届いていません（ほかのアプリや OS がマイクを止めています）。録音されていません',
    'micMessages.stalled':
        '音は届いていますが、文字起こしが出ていません（録音は続いています）。設定の「ブラウザのエコー除去」「ブラウザの雑音抑制」を切ると直ることがあります',
    'micMessages.suspended': '音声の処理が止まりました（電話や通知などのため）。「マイクを開き直す」を押してください',
    'micMessages.withLabel': '{message}（{label}）',

    // audio/microphone.ts
    'microphone.denied': 'マイクの使用が許可されていません',
    'microphone.insecure': 'このページではマイクを使えません（HTTPS で開いてください）',
    'microphone.missing': '選んだマイクが見つかりません',
    'microphone.openFailed': 'マイクを開けません: {message}',
    'microphone.processingFailed': '音声の処理を始められません: {message}',

    // reconnect.ts
    'reconnect.interrupted':
        '録音は途中で終わりました（接続が長く切れた・ホストが再起動したなど）。そこまでの録音は残っています',

    // recorder.ts
    'recorder.micDenied': 'マイクが使えません。ブラウザの設定でマイクを許可してください',
    'recorder.recovered': '録音に戻りました',
    'recorder.reopenFailed': 'マイクを開き直せません: {message}',
    'recorder.reopened': 'マイクを開き直しました。録音を続けています',
    'recorder.switchFailed': 'マイクを切り替えられません: {message}',
    'recorder.switched': 'マイクを切り替えました。録音を続けています',
    'recorder.unsentOverflow':
        '届いていない音声が多いため、ここから先はページを読み込み直すと消えます。閉じずに、つながるのを待ってください',
    'recorder.waitingLeftover': '前の録音の残りを送るのを待っています。つながってから、もう一度押してください',

    // recording.ts
    'recording.continueOther': '録音中は、ほかのセッションの続きを録音できません',
    'recording.locked': '録音中は変えられません',
    'recording.referenceMaterials': '録音中は参考資料を変えられません',
    'recording.regenerate': '録音中は再生成できません',

    // RecordingLock.tsx
    'recordingLock.locked': '録音中は設定を変更できません',

    // UnsentAlert.tsx
    'unsentAlert.leadMinutes': '前にページを開いていたとき、ホストに届かなかった録音が 約 {n} 分あります',
    'unsentAlert.leadSeconds': '前にページを開いていたとき、ホストに届かなかった録音が {n} 秒あります',
    'unsentAlert.send': '送って続きを録音',
    'unsentAlert.tail': '。送って、同じセッションの続きを録音できます',
    'unsentAlert.title': '（{title}）',

    // UnsentElsewhereAlert.tsx
    'unsentElsewhereAlert.offline': 'オフラインです',
    'unsentElsewhereAlert.offlineTitle': '{host} はオフラインです',
    'unsentElsewhereAlert.removedHost': '外したホストに届かなかった録音があります',
    'unsentElsewhereAlert.switch': '切り替える',
    'unsentElsewhereAlert.unsentOnHost': '{host} に届かなかった録音があります',
    'unsentElsewhereAlert.unsentOnOtherHost': 'ほかのホストに届かなかった録音があります',

    // unsentRecovery.ts
    'unsentRecovery.sendFailed': '届いていない音声を送れません: {message}',

    // upload.ts
    'upload.cutOff': 'アップロードが途中で切れました',
    'upload.rejected': 'ホストが受け付けませんでした（{status}）',

    // uploadActions.ts
    'uploadActions.busy': 'ほかのファイルをアップロード中です。終わってから選び直してください',
    'uploadActions.created': '{name} から作ります。要約まで少しかかります',
    'uploadActions.demo': 'デモでは音声ファイルを使えません',
    'uploadActions.failed': '{name} をアップロードできません: {message}',
    'uploadActions.failedItem': '{name}（{message}）',
    'uploadActions.merged': '{total} 個のファイルを 1 つのセッションにまとめて作ります。要約まで少しかかります',
    'uploadActions.oldHost': 'このホストは複数の音源に対応していないため、{name} だけのセッションにしました',
    'uploadActions.partialFailed': '{failed} を送れませんでした。届いた {n} 個のファイルで、30 分後に作ります',
    'uploadActions.progressName': '{name}（{i}/{total}）',
    'uploadActions.separator': '、',

    // watch.ts
    'watch.disconnected': 'ほかの端末で録音中（その端末とのつながりが切れています）',
    'watch.paused': 'ほかの端末で一時停止中',
    'watch.recording': 'ほかの端末で録音中',
    'watch.stopped': 'ほかの端末で録音を終えました',

    // watcher.ts
    'watcher.disconnected': '{source} との接続が切れました。録音は続いています',

    // 複数のファイルで使う文
    'common.chooseProject': '録音するプロジェクトをメニューから選んでください',
    'common.continueRecording': '続きから録音',
    'common.discard': '捨てる',
    'common.newSession': '新しいセッション',
});
