# 11. iOS アプリ

> [仕様書の目次](README.md)

iOS の PWA は、画面ロック中やバックグラウンドで録音を続けられない。ネイティブアプリにすればそれができるかを、最小の形で確かめる（#438）。この章はその検証用のアプリの決めごと。PR を 3 つに分けて作り、この章も PR ごとに書き足す（PR1：土台、PR2：録音のプラグイン、PR3：web からの呼び出し）。

## 11.1 位置づけ

- **検証用。** 確かめたいのは「画面ロックのまま 30 分録れるか」「割り込み（電話・Siri）でどう動くか」「電池の減り方」。ストアへの提出・クラウド版・ログイン・通知・Android は対象外
- 置き場所はリポジトリ直下の `mobile/`。独立した npm のパッケージで、web/・server/・relay/ の CI・設定（tsconfig・lint・prettier）には入れない
- Capacitor 8（`@capacitor/core`・`@capacitor/ios`・`@capacitor/cli` を同じ版で固定）。iOS の依存は Swift Package Manager で入れる（CocoaPods は使わない）
- アプリ ID（Bundle ID）は `dev.studiotakumi.remotewhisper`（Capacitor はハイフンを許さない）。Capacitor の設定では `appId`、Xcode では `PRODUCT_BUNDLE_IDENTIFIER`（`ios/App/App.xcconfig`）。手元で変えるときは `ios/App/Local.xcconfig`
- Capacitor は Dependabot に入れず、手で上げる。npm の `@capacitor/*`（3 つとも同じ版）と、`ios/App/CapApp-SPM/Package.swift` の `capacitor-swift-pm` の版は一緒に上げる必要があり、`npx cap sync ios` で `Package.swift` を書き直してからビルドを確かめる
- 録音しながらサーバーへ送る（リアルタイム文字起こし）のは、この検証が通ったら別の Issue で

## 11.2 画面の開き方（`server.url`）

- アプリは画面を持たず、セルフホスト版の画面（ホストの FastAPI が配信する `web/dist`）を Capacitor の `server.url` でそのまま開く。web/ のコピーは作らない
  - `webDir` は `../web/dist` を指す。表示には使わないが `cap sync` が要る
  - 開いた画面は普通のブラウザと同じく `/api/...`・`/ws` を同じオリジンで使う。iOS アプリのための API は足さない
- URL はリポジトリに入れない（公開しているため）。環境変数 `RW_SERVER_URL` か、Git に入れない `mobile/.env.local` から `capacitor.config.ts` が読み、`cap sync` のときにアプリの中の設定に書く。ないときは同梱の `web/dist` を開くだけになる（警告を出す）
- 本番の URL は Tailscale の https の前提。http を開ける ATS の例外は **Debug のビルドだけ** に足す（ビルドの途中で、できあがった Info.plist に `NSAllowsLocalNetworking` を足す。開けるのはローカルの宛先だけ）。開発用の Vite（`http://localhost:5190`）をシミュレーターで開くのに使う
- 署名の個人の値（Team ID・自分用の Bundle ID）は、Git に入れない `ios/App/Local.xcconfig` に書く。`project.pbxproj` には入れない
- 分かっていること：今の画面は safe area（ノッチ・ステータスバーの領域）を見ていないので、アプリの中で開くと上のバーがステータスバーに重なる（PR1 のシミュレーターで確認。WebView の `contentInset` では fixed の要素は動かないので直らない）。直すなら web/ 側で `env(safe-area-inset-*)` を使う。検証の妨げにならなければ後回し

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
| `resumed` | 割り込みが終わり、OS が再開してよいと言った（`shouldResume`）ので続きを録り始めた | `recording` |
| `interruptionEnded` | 割り込みが終わったが、`shouldResume` がなかったので止めた | `idle` |
| `routeChange` | 入力の経路が変わった（イヤホンを抜いた・挿したなど）。エンジンを新しい入力で作り直して録り続ける | `recording` |
| `mediaServicesReset` | メディアサービスがリセットされた。録音中ならエンジンを作り直して録り続ける | `recording` |
| `error` | 録り続けられなくなった（エンジンを作り直せない・書き込めない） | `idle` |

- 割り込み中の経路の変化・リセットは何もしない（再開するときにエンジンを作り直す）。アプリが止められていたことを後から知らせる割り込み（`appWasSuspended`）は割り込みとして扱わない
- 割り込みで止まっていた間は録らない（ファイルの時間は詰まる）

### JS 向けの API

型定義は PR3 で web/ に置く。ここに書いたものが正本。

| メソッド | 引数 | 返り値 | |
|---|---|---|---|
| `start()` | なし | `{ file: string }`（ファイル名） | マイクの許可をまだ聞いていなければ聞く |
| `stop()` | なし | `{ file: RecordingFile }` | 割り込み中（`interrupted`）でも止められる |
| `getStatus()` | なし | `{ state, file?: string, seconds: number }` | |
| `listRecordings()` | なし | `{ files: RecordingFile[] }` | 新しい順。録音中のファイルも入る |
| `readRecording({ name, offset?, length? })` | `offset` 既定 0、`length` 既定・上限 4MiB | `{ data: string（base64）, offset: number, size: number（ファイル全体） }` | 終わりを越えたら `data` は空 |
| `deleteRecording({ name })` | | なし | 録音中のファイルは消せない |

`RecordingFile` は `{ name: string, durationSec: number, size: number（バイト）, createdAt: string, modifiedAt: string }`（日時は ISO 8601）。

| イベント | 中身 | いつ |
|---|---|---|
| `stateChange` | `{ state, reason, file?: RecordingFile }` | 状態が変わったとき・経路の変化などで作り直したとき。`idle` になったときは録ったファイルが `file` に入る |
| `progress` | `{ seconds: number }` | 録っている間、1 秒ごと（録った長さ。割り込みで止まっていた間は増えない） |

失敗したときは reject し、`code` は `permission-denied`（マイクが許可されていない）・`already-recording`・`not-recording`・`no-input`（入力の装置がない）・`invalid-name`（このアプリの録音ファイルの名前でない）・`not-found`・`busy`（録音中のファイルを消そうとした）・`io`（そのほか）。

### ファイルを web に渡す方法

- **`readRecording` で 4MiB ずつ base64 で読み、web でつないで `File` にする。** `File` の名前は `name`、`lastModified` は `modifiedAt`（録り終えた時刻。サーバーは「更新日時 − 長さ」を開始日時にする。spec/flows.md 6.11）にして、今の「音声ファイルから作る」にそのまま渡す
- `Capacitor.convertFileSrc` の URL は使えない。画面を `server.url`（ホストの URL）で開いているので、変換した URL（`<ホスト>/_capacitor_file_/...`）はアプリの中ではなくホストに取りに行ってしまう
- 一度に base64 で全部返さないのは、1 時間で約 115MB（base64 で約 155MB）になり、ブリッジとメモリを詰まらせるため
- ファイルアプリにも出ているので、今の画面の「音声ファイルから作る」でファイルを選んでも送れる（コードは要らない）

### テスト

- `mobile/ios/App/AppTests`（XCTest。App の中で動く）：ファイル名・WAV のヘッダー・ヘッダーを直す間隔と落とされたあとの修復・置き場（一覧・区切って読む・消す・名前の確かめ）・状態の移り変わりの全部
- 本物のマイクで録るテスト（`RecorderMicTests`）は、`RW_MIC_TEST=1` のときだけ動く（マイクの許可と入力の装置が要るため）

## 11.4 web からの呼び出し

PR3 で書く。予定は、アプリの中で開いているとき（`Capacitor.isNativePlatform()`）だけ検証用の録音の操作を出し、ネイティブ用のコードは dynamic import にしてブラウザ版のバンドルに入れないこと。
