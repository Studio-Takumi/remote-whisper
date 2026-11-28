import { defineDictionary } from '@/i18n/messages';

// 設定（features/settings/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // 複数のファイルで使う文
    'common.detailedSummary': '要約詳細',
    'common.figureReading': '図の読み取り',
    'common.minutes': '分',
    'common.overview': '全体概要',
    'common.polish': '浄書',
    'common.realTimeSummary': 'リアルタイム要約',
    'common.referenceMaterials': '参考資料',
    'common.speakerLabeling': '話者分け',
    'common.summary': '要約',
    'common.thisDevice': 'この端末',
    'common.thisDeviceDescription': '保存を押さなくても、切り替えた時点で効きます',
    'common.transcript': '文字起こし',

    // DensitySelect.tsx
    'densitySelect.level1': '1 ごく短く',
    'densitySelect.level2': '2 短め',
    'densitySelect.level3': '3 ふつう',
    'densitySelect.level4': '4 詳しく',
    'densitySelect.level5': '5 できるだけ細かく',

    // DisplayPage.tsx
    'displayPage.allowedHosts': '許可するホスト名',
    'displayPage.allowedHostsDescription':
        'IP アドレス・localhost・Tailscale の名前・この PC の名前のほかに開く名前です。カンマで区切ります',
    'displayPage.connection': '接続',
    'displayPage.micShortcut': 'マイクボタンのショートカット',
    'displayPage.sessionMeta': 'サイドバーの録音日時と長さ',
    'displayPage.showPickedTerms': '用語リスト（文字起こし抽出）の表示',
    'displayPage.showSpeakers': '話者の表示',
    'displayPage.updateCheck': 'アップデートの確認',
    'displayPage.updateCheckDescription':
        'ホストの版と ID（クラウド版に登録していればホスト ID、していなければランダムな ID）を送って、新しい版を確かめます',

    // LanguageRow.tsx
    'languageRow.label': '表示言語',

    // LlmSection.tsx
    'llmSection.backend': '要約に使うアプリ',
    'llmSection.backendDescription':
        '要約・用語リスト・コンテキストを作るアプリです。録音中に変えたときは、録音が終わってから切り替わります',
    'llmSection.cancelClear': 'やめる',
    'llmSection.clear': '消す',
    'llmSection.token': '{llm} のトークン',
    'llmSection.tokenClearing': '保存すると消えます',
    'llmSection.tokenSet': '設定済みです。変えるときだけ入れます',
    'llmSection.tokenSetShort': '設定済み',
    'llmSection.tokenUnset': '{llm} で認証を求める設定にしたときだけ入れます',
    'llmSection.tokenUnsetShort': '未設定',
    'llmSection.tunnelLock': 'クラウド版からは変えられません',
    'llmSection.url': '{llm} の URL',

    // MaterialsPage.tsx
    'materialsPage.addFolder': 'フォルダを追加',
    'materialsPage.extensions': '拡張子',
    'materialsPage.folder': 'フォルダ {n}',
    'materialsPage.readFigures': 'PDF の図を読む',
    'materialsPage.readFiguresDescription':
        '図のあるページを画像にして読み、用語リストとコンテキストに使います。作るのに時間がかかります',
    'materialsPage.removeFolder': 'このフォルダを外す',
    'materialsPage.sourceFolders': '読み込めるフォルダ',
    'materialsPage.supportedFileTypes': '読み込める拡張子',

    // MicDeviceRow.tsx
    'micDeviceRow.allow': '許可する',
    'micDeviceRow.allowToChoose': 'マイクを許可すると選べます',
    'micDeviceRow.denied': 'マイクが使えません。ブラウザの設定でマイクを許可してください',
    'micDeviceRow.label': '録音に使うマイク',
    'micDeviceRow.notFound': '{label}（見つかりません）',
    'micDeviceRow.os': 'OS に任せる',
    'micDeviceRow.unsupported': 'このブラウザでは選べません',
    'micDeviceRow.waitingForDevice': 'つながるまで OS の既定のマイクで録音します',

    // ModelsPage.tsx
    'modelsPage.align': '時刻合わせ',
    'modelsPage.context': 'コンテキスト',
    'modelsPage.figuresDescription': 'PDF の図を読みます。画像を読めるモデルを選んでください',
    'modelsPage.finalSummary': '最終要約',
    'modelsPage.finalSummaryDescription': '録音終了後に作ります',
    'modelsPage.intro': '処理ごとのモデルです（{llm}）。薄い文字のものは表示だけで、選べません',
    'modelsPage.notInstalled': '入っていません',
    'modelsPage.polishDescription': '録音終了後に、録音全体から作り直します',
    'modelsPage.polishTranscript': 'WhisperX（Whisper: {model}。リアルタイム文字起こしと同じ）',
    'modelsPage.realTimeSummaryDescription': '録音中に数分おきに作ります（思考モードはオフ）',
    'modelsPage.realTimeTranscript': 'リアルタイム文字起こし',
    'modelsPage.referenceMaterialsDescription': '{llm} で、資料から用語リストとコンテキストを作ります',
    'modelsPage.restoreRecommended': 'おすすめに戻す',
    'modelsPage.scope': '範囲の判断',
    'modelsPage.scopeDescription': '資料のどこを使うかを判断します。小さいモデルでは答えが安定しません',
    'modelsPage.switching': '{llm} に切り替わると、入っているモデルから選べます',
    'modelsPage.termListFromMaterials': '用語リスト（資料抽出）',
    'modelsPage.termListFromTranscript': '用語リスト（文字起こし抽出）',
    'modelsPage.title': 'タイトル',
    'modelsPage.vad': '無音区間の判別',

    // options.ts
    'options.thinkingModeOn': '思考モードはオン',
    'options.thinkingModeOnMaybeOff': '思考モードはオン（対応していないモデルではオフで実行します）',
    'options.thinkingModeUnsupported': 'このモデルは思考モードに対応していないため、オフで実行します',

    // push.ts
    'push.denied': '通知が許可されていません。ブラウザの設定で、このサイトの通知を許可してください',
    'push.insecure': 'HTTPS で開いているときだけ使えます（http では使えません）',
    'push.unsupported':
        'このブラウザでは使えません。iPhone はホーム画面に追加したアプリ（iOS 16.4 以降）でだけ使えます',

    // PushToggle.tsx
    'pushToggle.enabled': '最終要約ができたら、この端末に通知します',
    'pushToggle.failed': '通知を設定できませんでした',
    'pushToggle.label': '最終要約の通知',

    // RecordingPage.tsx
    'recordingPage.autoGainControl': 'ブラウザの自動音量調整',
    'recordingPage.continueWindow': '録音を終えても、続きから録音できる時間',
    'recordingPage.echoCancellation': 'ブラウザのエコー除去',
    'recordingPage.maxConcurrent': '同時に録音できる数',
    'recordingPage.noiseSuppression': 'ブラウザの雑音抑制',
    'recordingPage.resumeTimeout': '接続が切れたときに待つ時間',

    // settings.ts
    'settings.autoDetect': '自動判定',
    'settings.sameAsTranscript': '文字起こしと同じ',

    // settingsActions.ts
    'settingsActions.loadFailed': '設定を読み込めません: {message}',
    'settingsActions.lockedWhileRecording': '録音中は、文字起こしのモデル・区切り・マイクの処理は変えられません',
    'settingsActions.notLoaded': '設定を読み込めていないため、保存できません',
    'settingsActions.saveFailed': '設定を保存できません: {message}',

    // SettingsDialog.tsx
    'settingsDialog.description': '全体設定（どの端末でも共通）',
    'settingsDialog.descriptionRecording': '全体設定（録音中は一部の項目は変更不可）',
    'settingsDialog.loadFailed': '設定を読み込めていません',
    'settingsDialog.reload': '再読み込み',
    'settingsDialog.title': '設定',

    // SettingsForm.tsx
    'settingsForm.cancel': 'キャンセル',
    'settingsForm.save': '保存',

    // SettingsTabList.tsx
    'settingsTabList.display': '表示・その他',
    'settingsTabList.models': 'モデル',
    'settingsTabList.recording': '録音',
    'settingsTabList.setup': 'セットアップ',
    'settingsTabList.storage': '保存',

    // SetupPage.tsx
    'setupPage.checking': '確かめています…',

    // ShortcutInput.tsx
    'shortcutInput.escToCancel': 'Esc で取り消します',
    'shortcutInput.modifierSeparator': '・',
    'shortcutInput.needsModifier': '{modifiers} のどれかと一緒に押してください',
    'shortcutInput.none': '使わない',
    'shortcutInput.pressKey': 'キーを押してください…',
    'shortcutInput.reset': '既定に戻す',

    // StoragePage.tsx
    'storagePage.days': '日',
    'storagePage.recordingFile': '録音ファイル',
    'storagePage.retention': '保存期間',
    'storagePage.retentionDescription': '期間を過ぎたファイルは自動で消えます。0 にすると無期限です',
    'storagePage.summaryDescription': '選んだディレクトリに置いたコピーは消しません',

    // SummaryPage.tsx
    'summaryPage.detailedSummaryDescription': '部分ごとの要約（短い録音では要約そのもの）',
    'summaryPage.keepAlive': '要約後にモデルを停止するまでの時間',
    'summaryPage.language': '要約の言語',
    'summaryPage.languageDescription': 'タイトルも同じ言語で付けます',
    'summaryPage.materialPages': '参考資料のページの表示',
    'summaryPage.materialPagesDescription':
        '要約詳細の項目に「〇〇.pdf p.12 の内容」のように資料の該当ページを表示します（PDF のみ）',
    'summaryPage.overviewDescription': '長い録音で、一番上に置く「全体概要」の箇条書き',
    'summaryPage.pickTerms': '録音中の用語抽出',
    'summaryPage.pickTermsDescription': 'GPU の負荷が上がります。参考資料のスイッチもオンのときだけ抽出します',
    'summaryPage.realTimeInterval': 'リアルタイム要約の間隔',
    'summaryPage.realTimeSummaryDescription': '約 4000 文字ごとの要約',
    'summaryPage.summaryDetailLevel': '要約度',
    'summaryPage.summaryDetailLevelDescription': '1 は要点だけで、5 になるにつれてより細かくなります',

    // ThemeToggle.tsx
    'themeToggle.current': 'テーマ: {name}',
    'themeToggle.dark': 'ダーク',
    'themeToggle.light': 'ライト',
    'themeToggle.system': 'OS に合わせる',
    'themeToggle.theme': 'テーマ',
    'themeToggle.tooltip': '{label}（押すと「{next}」に切り替えます）',

    // VersionInfo.tsx
    'versionInfo.mismatch': 'クライアントがホストと違うバージョンです',
    'versionInfo.releaseNotes': 'リリースノート',
    'versionInfo.reload': '読み込み直す',
    'versionInfo.updateAvailable': '{version} が出ています',
    'versionInfo.versions': 'ホスト {host} ・ クライアント {client}',

    // WhisperPage.tsx
    'whisperPage.beamSize': 'ビームサイズ',
    'whisperPage.beamSizeDescription': '大きいほど精度が上がりますが、遅くなります',
    'whisperPage.computeType': '計算の精度',
    'whisperPage.computeTypeDescription': 'int8 にすると VRAM が減りますが、精度が少し落ちます',
    'whisperPage.language': '文字起こしの言語',
    'whisperPage.languageDescription': '自動判定では、浄書のときに言語を判定します',
    'whisperPage.maxSegment': 'チャンクの最大の長さ',
    'whisperPage.milliseconds': 'ミリ秒',
    'whisperPage.partialInterval': '途中結果の間隔',
    'whisperPage.polishDescription': '録音終了後、文字起こしが読みやすくなるように浄書します',
    'whisperPage.seconds': '秒',
    'whisperPage.silence': '区切りとみなす無音',
    'whisperPage.speakerLabelingDescription':
        '浄書済み文字起こしを「話者 1」などに分けます。HuggingFace のトークンやモデルの利用条件への同意が必要です',
    'whisperPage.speechAuto': '自動',
    'whisperPage.speechDbfs': '手動のときの音量',
    'whisperPage.speechDbfsDescription': 'この音量より大きい音を話し声とみなします（-70〜-10）',
    'whisperPage.speechManual': '手動（音量）',
    'whisperPage.speechThreshold': '話し声の判定',
    'whisperPage.speechThresholdDescription': '自動では Silero VAD で判定し、手動では音量で判定します',
    'whisperPage.unloadAfter': '録音終了後にモデルを停止するまでの時間',
});
