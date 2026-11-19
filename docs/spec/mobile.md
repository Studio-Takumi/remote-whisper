# 11. iOS アプリ

> [仕様書の目次](README.md)

iOS の PWA は、画面ロック中やバックグラウンドで録音を続けられない。ネイティブアプリにすればそれができるかを、最小の形で確かめる（#438）。この章はその検証用のアプリの決めごと。PR を 3 つに分けて作り、この章も PR ごとに書き足す（PR1：土台、PR2：録音のプラグイン、PR3：web からの呼び出し）。

## 11.1 位置づけ

- **検証用。** 確かめたいのは「画面ロックのまま 30 分録れるか」「割り込み（電話・Siri）でどう動くか」「電池の減り方」。ストアへの提出・クラウド版・ログイン・通知・Android は対象外
- 置き場所はリポジトリ直下の `mobile/`。独立した npm のパッケージで、web/・server/・relay/ の CI・設定（tsconfig・lint・prettier）には入れない
- Capacitor 8（`@capacitor/core`・`@capacitor/ios`・`@capacitor/cli` を同じ版で固定）。iOS の依存は Swift Package Manager で入れる（CocoaPods は使わない）
- アプリ ID（Bundle ID）は `dev.studiotakumi.remotewhisper`（Capacitor はハイフンを許さない）。Capacitor の設定では `appId`、Xcode では `RW_APP_BUNDLE_IDENTIFIER`（`ios/App/App.xcconfig`。`PRODUCT_BUNDLE_IDENTIFIER` はこれから作る）。手元で変えるときは `ios/App/Local.xcconfig` で `RW_APP_BUNDLE_IDENTIFIER` を書き換える（Widget Extension の Bundle ID も一緒に変わる。11.5 節）
- Capacitor は Dependabot に入れず、手で上げる。npm の `@capacitor/*`（3 つとも同じ版。web/ の `@capacitor/core` も。11.4 節）と、`ios/App/CapApp-SPM/Package.swift` の `capacitor-swift-pm` の版は一緒に上げる必要があり、`npx cap sync ios` で `Package.swift` を書き直してからビルドを確かめる
- 録音しながらサーバーへ送る（リアルタイム文字起こし）のは、この検証が通ったら別の Issue で

## 11.2 画面の開き方（`server.url`）

- アプリは画面を持たず、セルフホスト版の画面（ホストの FastAPI が配信する `web/dist`）を Capacitor の `server.url` でそのまま開く。web/ のコピーは作らない
  - `webDir` は `../web/dist` を指す。表示には使わないが `cap sync` が要る
  - 開いた画面は普通のブラウザと同じく `/api/...`・`/ws` を同じオリジンで使う。iOS アプリのための API は足さない
- URL はリポジトリに入れない（公開しているため）。環境変数 `RW_SERVER_URL` か、Git に入れない `mobile/.env.local` から `capacitor.config.ts` が読み、`cap sync` のときにアプリの中の設定に書く。ないときは同梱の `web/dist` を開くだけになる（警告を出す）
- 本番の URL は Tailscale の https の前提。http を開ける ATS の例外は **Debug のビルドだけ** に足す（ビルドの途中で、できあがった Info.plist に `NSAllowsLocalNetworking` を足す。開けるのはローカルの宛先だけ）。開発用の Vite（`http://localhost:5190`）をシミュレーターで開くのに使う
- 署名の個人の値（Team ID・自分用の Bundle ID）は、Git に入れない `ios/App/Local.xcconfig` に書く。`project.pbxproj` には入れない
- safe area（ノッチ・ステータスバーの領域）：アプリの中で開くと上のバーがステータスバーに重なっていた（PR1。WebView の `contentInset` では fixed の要素は動かないので直らない）。web/ 側で、アプリの中でだけ `env(safe-area-inset-*)` の余白を当てて直した（11.4 節）
- 候補（実機の結果を見て決める）：経路の変化の保険。`AVAudioEngineConfigurationChange` は入力の形式が変わったときだけ来るので、`AVAudioSession.routeChangeNotification` も見て、`recording` なのにエンジンが止まっていたら作り直す（11.3 節）

## 11.3 録音のプラグイン

アプリの中だけのプラグイン（npm のパッケージにしない）。JS からは `Capacitor.Plugins.Recorder`（`registerPlugin('Recorder')`）で呼ぶ。

### 置き場所と登録

- コードは `mobile/ios/App/App/Recorder/`。`MainViewController`（`CAPBridgeViewController` を継承した 1 段だけのクラス。`SceneDelegate` と `Main.storyboard` がこれを使う）の `capacitorDidLoad()` で `bridge?.registerPluginInstance(RecorderPlugin())` する
- 役割は分けて、継承では重ねない。`RecorderPlugin`（JS との受け渡しだけ）が `Recorder`（AVAudioSession `.record` ＋ AVAudioEngine で録る）と `RecordingStore`（ファイルの置き場）を持つ。状態の移り変わりは `RecorderStateMachine`、WAV の読み書きは `WavWriter`・`WavRepair`
- Info.plist：`UIBackgroundModes` に `audio`（画面ロック中・バックグラウンドでも録る）、`NSMicrophoneUsageDescription`、ファイルアプリから見えるように `UIFileSharingEnabled`・`LSSupportsOpeningDocumentsInPlace`

### 録音ファイル

- **形式は WAV（16kHz・モノラル・16bit の PCM）。** 理由：
  - サーバーの「音声ファイルから作る」（spec/flows.md 6.11）は wav を受け付け、録音したときと同じ 64kbps の mp3 に変換して置く。1 時間で約 115MB で、アップロードの上限（`recording.uploadMaxMb`、既定 2048MB）に十分収まる
  - 少しずつ書いても、落とされたときに録った分が残る。m4a（AAC）は最後に索引（moov）を書くまで読めないので、録音中にアプリを落とされると全部失う
  - 16kHz・モノラルは Whisper に渡す形で、サーバーのリアルタイム録音と同じ
- 置き場所はアプリの `Documents/recordings/`（ファイルアプリの「このiPhone内 → Remote Whisper → recordings」）。名前は `recording-YYYYMMDD-HHMMSS.wav`（端末の時刻で、録り始めた時刻。同じ秒に 2 つ目ができたら `-2` を付ける）
- 書き方：マイクの入力を 16kHz・モノラルの Int16 に変換して、届くたびにファイルの後ろに足す。ヘッダーの長さは 5 秒分ごとと、止めたときに直す。アプリを起動したとき（プラグインを読み込んだとき）に、ヘッダーの長さがファイルの大きさと合わないもの（落とされて閉じられなかったもの）を直す

### 状態と止まる理由

| 状態 | 意味 |
|---|---|
| `idle` | 録っていない |
| `recording` | 録っている |
| `interrupted` | 電話などの割り込みで止まっている。ファイルは開いたままで、割り込みが終わったら続きを同じファイルに録る |

| 理由（`reason`） | いつ | 状態 |
|---|---|---|
| `user` | JS から `start`・`stop` を呼んだ | `recording`・`idle` |
| `interruption` | 割り込み（電話・Siri・ほかのアプリの録音など）が始まった | `interrupted` |
| `resumed` | 割り込みが終わった（または前面に戻った）ので、続きを録り始めた | `recording` |
| `interruptionEnded` | 割り込みが終わったので再開を試みたが、できなかったので止めた（ほかのアプリが音声を使い続けているなど） | `idle` |
| `routeChange` | 入力の経路が変わった（イヤホンを抜いた・挿したなど）。エンジンを新しい入力で作り直して録り続ける | `recording` |
| `mediaServicesReset` | メディアサービスがリセットされた。録音中ならエンジンを作り直して録り続ける | `recording` |
| `error` | 録り続けられなくなった（エンジンを作り直せない・書き込めない） | `idle` |

- **割り込みが終わったら、`shouldResume` の有無にかかわらず再開を試みる。** 講義の録音では画面ロックのままのことが多く、止まっても気づけず残りを全部失う。録音を勝手に再開しても音は鳴らない。`shouldResume` がないのはほかのアプリが音声を使い続けているときが多く、そのときは再開（`setActive(true)`）が失敗するので、`interruptionEnded` で止める。`shouldResume` の有無はログに出す
- 割り込みの終わりは必ず届くとは限らないので、アプリが前面に戻ったとき（`willEnterForeground`）にまだ `interrupted` なら再開を試みる。できなければ止めずに、割り込みの終わりを待つ
- 割り込み中の経路の変化・リセットは何もしない（再開するときにエンジンを作り直す）。アプリが止められていたことを後から知らせる割り込み（`appWasSuspended`）は割り込みとして扱わない
- 割り込みで止まっていた間は録らない（ファイルの時間は詰まる）

### JS 向けの API

型定義は `web/src/features/native/recorderTypes.ts`。ここに書いたものが正本。

| メソッド | 引数 | 返り値 | |
|---|---|---|---|
| `start()` | なし | `{ file: string }`（ファイル名） | マイクの許可をまだ聞いていなければ聞く |
| `stop()` | なし | `{ file: RecordingFile }` | 割り込み中（`interrupted`）でも止められる |
| `getStatus()` | なし | `{ state, file?: string, seconds: number }` | |
| `listRecordings()` | なし | `{ files: RecordingFile[] }` | 新しい順。録音中のファイルも入る |
| `readRecording({ name, offset?, length? })` | `offset` 既定 0、`length` 既定・上限 4MiB | `{ data: string（base64）, offset: number, size: number（ファイル全体） }` | 終わりを越えたら `data` は空。`offset`・`length` が負なら `invalid-argument` |
| `deleteRecording({ name })` | | なし | 録音中のファイルは消せない |

`RecordingFile` は `{ name: string, durationSec: number, size: number（バイト）, createdAt: string, modifiedAt: string }`（日時は ISO 8601）。

| イベント | 中身 | いつ |
|---|---|---|
| `stateChange` | `{ state, reason, file?: RecordingFile }` | 状態が変わったとき・経路の変化などで作り直したとき。`idle` になったときは録ったファイルが `file` に入る |
| `progress` | `{ seconds: number }` | 録っている間、1 秒ごと（録った長さ。割り込みで止まっていた間は増えない） |

失敗したときは reject し、`code` は `permission-denied`（マイクが許可されていない）・`already-recording`・`not-recording`・`no-input`（入力の装置がない）・`invalid-name`（このアプリの録音ファイルの名前でない）・`invalid-argument`（`readRecording` の `offset`・`length` が負）・`not-found`・`busy`（録音中のファイルを消そうとした）・`io`（そのほか）。

### ファイルを web に渡す方法

- **`readRecording` で 4MiB ずつ base64 で読み、web でつないで `File` にする。** `File` の名前は `name`、`lastModified` は `modifiedAt`（録り終えた時刻。サーバーは「更新日時 − 長さ」を開始日時にする。spec/flows.md 6.11）にして、今の「音声ファイルから作る」にそのまま渡す
- `Capacitor.convertFileSrc` の URL は使えない。画面を `server.url`（ホストの URL）で開いているので、変換した URL（`<ホスト>/_capacitor_file_/...`）はアプリの中ではなくホストに取りに行ってしまう
- 一度に base64 で全部返さないのは、1 時間で約 115MB（base64 で約 155MB）になり、ブリッジとメモリを詰まらせるため
- ファイルアプリにも出ているので、今の画面の「音声ファイルから作る」でファイルを選んでも送れる（コードは要らない）

### テスト

- `mobile/ios/App/AppTests`（XCTest。App の中で動く）：ファイル名・WAV のヘッダー・ヘッダーを直す間隔と落とされたあとの修復・置き場（一覧・区切って読む・消す・名前の確かめ）・状態の移り変わりの全部・形式の変換（合成した 48kHz・2ch の正弦波を続けて渡し、長さ・欠けがないこと・振幅を見る）
- 本物のマイクで録るテスト（`RecorderMicTests`）は、`RW_MIC_TEST=1` のときだけ動く（マイクの許可と入力の装置が要るため）

## 11.4 web からの呼び出し

アプリの中で開いているときだけ、検証用の録音の操作を出す。ブラウザ版（Safari・PWA を含む）の画面・動き・最初に読むファイルは変えない。コードは `web/src/features/native/`。

### 見分け方とコードの分け方

- **アプリの中かどうかは `window.Capacitor?.isNativePlatform()` で見る（`nativePlatform.ts`）。** Capacitor が画面の読み込み前に `window.Capacitor` を差し込むので、`@capacitor/core` を読み込まずに分かる
- **ネイティブを呼ぶコード（`@capacitor/core`。プラグインの登録・SystemBars）は `nativeBridge.ts` にだけ置き、dynamic import で読み込む。** ブラウザ版では読み込まれない（別のチャンク `nativeBridge-*.js`）。`@capacitor/core` は web/ の依存に入れ、版は `mobile/` と同じにそろえる
- 画面の部品（「iOS アプリ」ページ）は最初のチャンクに入れる（約 6KB。ブラウザ版では描かない）。部品を `lazy` で別のチャンクにすると、ビルドが共通のランタイムを別のファイルに分け、ブラウザ版の最初に読むファイルが 1 つ増えるため（PWA が最初に取っておくファイルにも入らない）
- プラグインは Proxy なので、Promise の結果にそのまま渡さない（`then` を呼ばれ、ネイティブのメソッドとして呼びに行く）。`{ plugin }` に包んで返す

### 入口（設定モーダルの「iOS アプリ」）

- 設定モーダルのタブの最後に「iOS アプリ」を足す（URL は `/settings/ios`）。ブラウザ版ではタブを出さず、`/settings/ios` は知らないページとして最初のページを開く。ブラウザ版のタブの並びは変えない
- 録音：状態（停止中・録音中・割り込み中）・経過時間（`progress`）・理由（最後の `stateChange` の `reason`）と、録音開始・録音停止のボタン。失敗したら `code` ごとの文言を出す（`no-input` は「マイクが見つかりません」など）
- 録音ファイル：`listRecordings` の一覧（名前・長さ・大きさ・作成日時）。ファイルごとに「セッションを作る」と「削除」（ほかの画面と同じダイアログで確かめてから）。録音中のファイルはどちらも押せない。止まったとき（`idle` の `stateChange`）に一覧を取り直す
- このタブには保存するものがないので、下の「保存」「キャンセル」は出さない（ほかのタブは今までどおり）
- イベント（`stateChange`・`progress`）はページを開いている間だけ購読し、閉じたら外す。購読できなかったら（プラグインが登録されていないなど）文言を出す

### ファイルの渡し方

- 「セッションを作る」は、11.3 節のとおり `readRecording` を 4MiB ずつ `size` に届くまで呼び、base64 を戻してつなぎ、`File`（`type: 'audio/wav'`、`lastModified` は `modifiedAt`）にして、今の「音声ファイルから作る」の処理（ストアの `uploadAudio`。spec/flows.md 6.11）にそのまま渡す。アップロードの処理は変えない
- 返ってきた `offset` が頼んだ位置と違ったら、つながずに `io` で失敗にする（ネイティブ側の不具合に気づけるように）
- 分かっていること：読んだ分（`Uint8Array` の配列）と `new File(...)` のコピーが同時に乗るので、メモリはファイルの約 2 倍使う（1 時間で約 230MB）。検証用なのでこのまま。実機で長いファイルが落ちるなら、読みながら `Blob` につなぐ形にする
- 入れる先は、今開いているプロジェクト（新規セッション画面・セッション画面で開いているもの）。今の「音声ファイルから作る」がそのプロジェクトの新規セッション画面にあるのにそろえた。開いていなければ押せない
- 読んでいる間は「〜を読み込んでいます… N%」、送っている間は今のアップロードと同じく進み具合を出す。作れたらそのセッションが開く（設定モーダルは開いたまま）

### safe area

- アプリの中で開いたときだけ `<html>` に `rw-native` を付け、`index.css` の `.rw-native` の下だけで余白を当てる。ブラウザ版の CSS と `index.html` の meta は変えない（Safari・PWA の見た目が変わるため）
  - 上のバー（`data-slot='top-bar'`）：上の余白に `env(safe-area-inset-top)` を足す。上に貼り付けて背景を塗っているので、ステータスバーの下まで塗れ、高さ（`--top-bar-height`）に入るので下に貼るタブもずれる
  - サイドバー（スマホの幅）と参考資料メニューなどのシート：上下に `env(safe-area-inset-top)`・`env(safe-area-inset-bottom)`。閉じるボタンも下げる
  - マイクボタンは前から `env(safe-area-inset-bottom)` を見ている
- `env()` は `viewport-fit=cover` のときだけ値が入る。`index.html` の meta に前から付いているが、付いていなければアプリの中でだけ足す
- ステータスバーの文字の色は、画面のテーマ（`<html>` の `.dark`）に合わせて Capacitor の `SystemBars.setStyle` で変える（既定は端末の外観に合わせるので、画面だけダークにすると文字が溶ける）。Capacitor 8 の SystemBars は iOS では余白を扱わないので、余白は CSS で当てる

### 確かめ方

- web のテスト（vitest）：ブラウザではタブも操作も出ず、`nativeBridge`・`@capacitor/core` を読み込まないこと。偽物のプラグインで、開始・停止・イベントの表示・購読の解除・一覧・「セッションを作る」に渡す `File`。分けて読んでつなぐところ
- ブラウザ版が変わっていないこと：変更の前後で、Playwright で PC（1280 幅）とスマホ（390 幅）・ライトとダークの画面（最初の画面・新規セッション画面・セッション画面・サイドバー・設定モーダルの全部のタブ）を撮ってピクセルで比べる。`npm run build` の前後で、最初に読むファイル（`index.html` が読む JS・CSS）の数が変わらず、増えたチャンクが `nativeBridge-*.js` だけなことを見る

## 11.5 Live Activity

いつもの Web の録音（WebSocket で送る録音）の状態を、ロック画面の Live Activity とダイナミックアイランドに出し、そこから一時停止・再開・終了できるようにする（#453）。

### 方針

- **録音は Web のまま、ネイティブは表示と入り口だけ。** #438 の実機の確認で、アプリの中の Web の録音は画面ロック中も送り続けられると分かった（裏にいても JS が動く）。録音の処理を Swift に作り直さない。11.3 節の録音のプラグイン（「iOS アプリ」タブの録音）とは別のもので、そちらには関わらない
- Live Activity のボタンは `LiveActivityIntent`（iOS 17 から）。アプリのプロセスで動くので、プラグインのイベントで web/ に伝え、マイクボタンと同じいつもの一時停止・再開・終了の処理（ストアの `pauseRecording`・`resumeRecording`・`stopRecording`）を通す
- 版：アプリは iOS 15 から（変えない）。Live Activity は iOS 16.1、ボタンは iOS 17 から（`@available` で分ける）。16.1 より前はプラグインが何もせず `{ shown: false }` を返す。16.1〜16.x はボタンのない Live Activity を出す。ActivityKit・AppIntents は弱いリンクになる（iOS 15 でも起動できる）
- ブラウザ版（Safari・PWA を含む）は変えない。web/ の呼び出しは `isNativeApp()` のときだけ動き、`nativeBridge-*.js` のチャンクにだけ入る（11.4 節の決まりのまま）

### 置き場所

| パス | 中身 |
|---|---|
| `mobile/ios/App/Shared/` | App と Widget Extension の両方に入れるもの。`RecordingActivityAttributes`・`RecordingActivityState`（ContentState）・ボタンの操作（`RecordingActivityAction`）・`LiveActivityIntent` の 3 つ |
| `mobile/ios/App/App/LiveActivity/` | JS 向けのプラグイン `LiveActivityPlugin`（受け渡しだけ）、出す・変える・終えるを持つ `LiveActivityController`、ActivityKit を呼ぶ `ActivityKitClient`、見た目を確かめる `LiveActivityPreview`（Debug だけ） |
| `mobile/ios/App/Widgets/` | Widget Extension（ターゲット `Widgets`）。Live Activity とダイナミックアイランドの見た目。ホーム画面のウィジェット（#454）もここに足す |
| `web/src/features/native/liveActivitySync.ts` | ストアを見てプラグインを呼び、ボタンの操作をストアのアクションに渡す |

- プラグインは `MainViewController` の `capacitorDidLoad()` で `RecorderPlugin` と並べて登録する。クラスは継承で重ねず、`LiveActivityPlugin` が `LiveActivityController` を持ち、`LiveActivityController` が `LiveActivityClient`（本物は `ActivityKitClient`、テストでは偽物）を持つ
- Widget Extension の Bundle ID はアプリのものの後ろに `.widgets`（`ios/App/Widgets.xcconfig`）。Team ID は App と同じく `Local.xcconfig` から読む。Extension の最低の版は iOS 16.1（それより前の端末では読み込まれない）
- アプリの `Info.plist` に `NSSupportsLiveActivities`

### 中身（ActivityKit）

- `RecordingActivityAttributes`（変わらないもの）：`sessionId` だけ
- `RecordingActivityState`（ContentState）：`phase`（`recording`・`paused`）・`startedAt`（経過時間が 0 だった時刻）・`elapsed`（秒）・`title`（セッション名）・`lines`（直近のリアルタイム文字起こし、古い順）
  - セッション名は録音中に仮のタイトル（途中の要約から作るもの）に変わるので、Attributes ではなく ContentState に持つ
  - 経過時間は毎秒 update しない。`startedAt = 今 − elapsed` にして、`Text(timerInterval:)` で端末に数えさせる。一時停止中は `pauseTime`（`startedAt + elapsed`）で止めて出す。表示は端末の形（1 時間までは `12:34`、超えたら `1:12:34`）
  - 行は空のものを除いて最後の 3 行。1 行は 120 文字まで（長いときは後ろ、新しく話したところを残す）。ActivityKit の中身の上限（4KB）に収めるため

### JS 向けの API（`LiveActivity`）

型定義は `web/src/features/native/liveActivityTypes.ts`。

| メソッド | 引数 | 返り値 | |
|---|---|---|---|
| `start(o)` | `{ sessionId, state, elapsed, title, lines }` | `{ shown: boolean }` | 同じセッションのものを出していれば中身を変えるだけ。別のセッションのものは終えてから出す。設定で許可されていなければ `shown: false` |
| `update(o)` | `{ state, elapsed, title, lines }` | `{ shown: boolean }` | 出していなければ何もしない |
| `end()` | なし | なし | このアプリの Live Activity を全部終える（ロック画面にも残さない） |

`state` は `recording`・`paused`。引数がおかしければ `invalid-argument`、ActivityKit が出せなければ `unavailable` で reject する。

| イベント | 中身 | いつ |
|---|---|---|
| `action` | `{ action: 'pause' \| 'resume' \| 'stop' }` | Live Activity のボタンが押された |

### web/ の動き

- 起動したとき（`main.tsx` の `startLiveActivity`）、アプリの中でだけ `nativeBridge` を読み込み、`LiveActivitySync` で見始める
- 見始めたときにまず `end()` する（画面を読み込み直す前に出したものを残さない）。プラグインも、読み込まれたとき（アプリを開き直したとき）に残っているものを全部終える
- アプリが落とされると Web の録音も終わる（#448 で、開き直した画面がそのセッションを終わりにする）が、Live Activity は終える処理が動かないので、**開き直すまでロック画面に残る**（iOS は最大 8 時間ほど出し続ける）。開き直したときに上のとおり片付ける
- ストアの `recordingState`・`recordingSessionId` から決める
  - 録音を始めた（`idle` 以外になった）：`start`。録音中のセッションが変わったときも `start`
  - `start` が `{ shown: false }`（設定で許可されていない・iOS 16.1 より前）か失敗したときは、出したことにしない。経過時間のほか（状態・マイクの状態・行・セッション名）が変わったときに `start` し直す（録音中に設定で許可されたら、そこから出る）
  - 一時停止・再開：すぐ `update`（経過時間もここで合わせ直す）
  - マイクが止まった・戻った（`micState`。#447）：すぐ `update`。止まっている間は録音した長さ（`elapsed`）が増えないのに端末の数える時間は進むので、ここで合わせ直す
  - 文字起こしの行・セッション名が変わった：5 秒に 1 回まで間引いて、そのときの最新のものを `update`（ActivityKit の更新の頻度の制限）。経過時間だけの変化では送らない
  - 録音を終えた（`idle`）：`end`。待っていた行の更新は捨てる
- プラグインは呼んだ順に流す。失敗しても録音には関わらないので捨てる
- `action` は、そのときの状態で押せるものだけ通す（`pause` は録音中、`resume` は一時停止中、`stop` は `idle` 以外）。届くのが遅れて状態が変わっていたら何もしない

### 見た目

匠が Pencil で作った採用案（ライトとダーク）。ボタンの色は本体のマイクボタンと同じ（一時停止＝赤 `#EF4444`、再開＝琥珀 `#F59E0B`、終了＝灰色）。

- ロック画面・録音中：左上に赤い点と経過時間（等幅）、右上にセッション名。直近の文字起こし 3 行（古い行ほど薄く小さく、最後の行は太字）。下に「一時停止」と「終了」
- ロック画面・一時停止中：琥珀の一時停止の印と経過時間（琥珀）、セッション名、最後の 1 行（薄く）。「再開」と「終了」
- ダイナミックアイランド（テーマによらず黒）：compact は左に赤い波形の印・右に経過時間、minimal は波形の印だけ。expanded はロック画面の録音中と同じ中身で、行は 2 行。一時停止中は印を琥珀の一時停止の印にする
- iOS 16.1〜16.x はボタンを出さない
- ロック画面の色（ライト・ダーク）は iOS が決める外観に従う（端末の設定ではなく、ロック画面の壁紙などで暗い外観になることがある）

### 確かめ方

- Swift のテスト（XCTest。`AppTests/LiveActivityTests.swift`）：ContentState の作り方（経過時間の起点・一時停止の時刻・行の間引き・長い行・4KB に収まること）、JS の引数の読み方、`LiveActivityController` の状態の移り変わり（偽物の `LiveActivityClient` で、出す・変える・終える・別のセッション・許可されていない）
- web のテスト（vitest。`liveActivity.test.ts`）：ブラウザでは `nativeBridge`・`@capacitor/core` を読み込まないこと。偽物のプラグインで、start・update・end の順と中身、録音中のセッションが変わったときの start、マイクの状態の変化での update、出せなかった・失敗したときの start のし直し、行の間引き、止めたら待っていた更新を捨てること、ボタンのイベントでいつもの一時停止・再開・終了が呼ばれること
- 見た目：シミュレーターはマイクの入力がなく録音を始められないので、Debug のビルドの起動の引数 `-RWLiveActivityPreview recording`（または `paused`）で見本を出す（`LiveActivityPreview`。Release には入らない）。ロック画面とダイナミックアイランドのライト・ダークを撮って比べる
- 実機：Web の録音で、ロック画面とダイナミックアイランドに出ること・ボタンで一時停止・再開・終了できること・録音を終えたら消えること・アプリを落としてから開き直したら残っていないこと
