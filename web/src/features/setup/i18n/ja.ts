import { defineDictionary } from '@/i18n/messages';

// セットアップ（features/setup/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // 複数のファイルで使う文
    'common.cancel': 'やめる',
    'common.installed': '入っています',
    'common.recheck': 'もう一度確かめる',

    // GpuStep.tsx
    'gpuStep.getCudaBuild': 'Windows（CUDA）版を入手',
    'gpuStep.notFound':
        'GPU が見つからないため、文字起こしは CPU で動きます。GPU より数倍以上遅くなり、文字が出るまで時間がかかります。モデルを small などの小さいものにすると速くなります',
    'gpuStep.purpose': '文字起こしを速くするためのもの',
    'gpuStep.wrongBuild':
        'NVIDIA の GPU が見つかりましたが、この Remote Whisper は Windows（OpenVINO）版のため、GPU を使わずに CPU で動きます。Windows（CUDA）版を入れ直すと、GPU で速く動きます（録音と文字起こしの記録はそのまま残ります）',

    // LlmStep.tsx
    'llmStep.lmStudioStart':
        'LM Studio のサーバーを起動してください。LM Studio の「Developer」でサーバーをオンにするか、',
    'llmStep.lmStudioStartAfter': ' を実行します',
    'llmStep.notInstalled': '入っていないため、要約と用語リストは作られません',
    'llmStep.ollamaNotRunning': 'Ollama が起動していません。起動してから確かめてください',
    'llmStep.openDownloadPage': 'ダウンロードのページを開く',
    'llmStep.purpose': '要約と用語リストを作るアプリ',
    'llmStep.running': '動いています',
    'llmStep.serverRunning': 'サーバーが動いています',
    'llmStep.unauthorized': 'LM Studio のトークンが違うため接続できません。設定の「要約」で確かめてください',

    // ModelsStep.tsx
    'modelsStep.downloadCancelled': '取得をやめました',
    'modelsStep.downloadFailed': '取得できませんでした',
    'modelsStep.downloading': '{model} の取得',
    'modelsStep.lmStudioNote':
        '録音中は {model} を使います。入っていないと大きいモデルで代わりに動くため、VRAM が 6GB ほどの GPU では文字起こしが遅くなります',
    'modelsStep.notInstalled': '入っていません',
    'modelsStep.purpose': '要約などに使う {llm} のモデル',
    'modelsStep.stopInLmStudio': '止めるときは LM Studio の画面から止めてください',
    'modelsStep.title': '要約のモデル',

    // pullModels.ts
    'pullModels.button': '取得',
    'pullModels.buttonAtLeast': '取得（約 {gb} GB 以上）',
    'pullModels.buttonWithSize': '取得（約 {gb} GB）',
    'pullModels.progress': '{where}{model} を取得中（{index}/{total}）{amount}',
    'pullModels.progressAmount': '・{percent}%（{done} / {total}）',
    'pullModels.progressWhere': '{llm} で ',
    'pullModels.waitForLlm': '{llm} が動いてから取得できます',
    'pullModels.waitForRecording': '録音が終わってから取得できます',

    // setup.ts
    'setup.elapsedMinutes': '{m} 分 {s} 秒',
    'setup.elapsedSeconds': '{s} 秒',
    'setup.phaseDownloading': 'ダウンロード中',
    'setup.phaseInstalling': 'インストール中',
    'setup.phasePreparing': '準備中',
    'setup.phaseRollingBack': '元に戻しています',

    // SetupDialog.tsx
    'setupDialog.close': '閉じる',
    'setupDialog.description': '要約・浄書・話者分けに使うものを入れます。設定の「セットアップ」からいつでも開けます',
    'setupDialog.later': 'あとで',
    'setupDialog.title': 'はじめに',

    // SetupGuide.tsx
    'setupGuide.cloudReadOnly': 'クラウド版からは見るだけです。ホストで直接開いた画面から操作してください',
    'setupGuide.failed': 'できませんでした',
    'setupGuide.skippable': 'どれも飛ばせます（文字起こしはそのまま使えます）。ボタンを押した時点で実行します',

    // StepParts.tsx
    'stepParts.missing': '足りません',
    'stepParts.ready': 'そろっています',

    // TokenStep.tsx
    'tokenStep.delete': '削除',
    'tokenStep.fromEnv': '環境変数 HF_TOKEN のトークンを使っています',
    'tokenStep.fromLogin': 'hf auth login で保存したトークンを使っています',
    'tokenStep.modelPage': '話者分けのモデルのページ',
    'tokenStep.modelPageAfter': 'で、ログインして利用条件に同意します',
    'tokenStep.purpose': '話者分けのモデルを取るためのもの',
    'tokenStep.save': '保存',
    'tokenStep.saved': '保存済み',
    'tokenStep.title': 'HuggingFace のトークン',
    'tokenStep.tokensPage': 'アクセストークンのページ',
    'tokenStep.tokensPageAfter': 'で Read のトークンを作り、下に貼ります',

    // useSetupStatus.ts
    'useSetupStatus.loadFailed': 'セットアップの状態を取得できませんでした',

    // WhisperXStep.tsx
    'whisperXStep.cancelled': 'やめて、元に戻しました',
    'whisperXStep.cost':
        '約 {download} GB をダウンロードし、ディスクを約 {disk} GB 使います。{min}〜{max} 分かかります',
    'whisperXStep.devCommand': '開発の環境では、server のフォルダで次のコマンドを実行してください',
    'whisperXStep.install': '入れる',
    'whisperXStep.notInstallable': 'この版では画面から入れられません。新しい版のインストーラを入れてください',
    'whisperXStep.package': '：{name}',
    'whisperXStep.progress': '{phase}{package}（経過 {elapsed}）',
    'whisperXStep.purpose': '浄書と話者分けに使うライブラリ',
    'whisperXStep.rollbackFailed':
        '入れられず、元にも戻せませんでした。インストーラで入れ直してください（ログはデータのフォルダの log/whisperx-install.log）',
    'whisperXStep.rolledBack':
        '入れられなかったため、元に戻しました（ログはデータのフォルダの log/whisperx-install.log）',
    'whisperXStep.waitForRecording': '録音が終わってから入れられます',
});
