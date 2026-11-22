# mobile（iOS アプリ・検証用）

iOS アプリの土台（#438。画面ロック中やバックグラウンドでも録音できるかの検証から始まった。仕様は [spec/mobile.md](../docs/spec/mobile.md)）。

- セルフホスト版の画面を、アプリの中でそのまま開く（Capacitor の `server.url`）。web/ のコピーは持たない
- 録音はアプリの中でもいつもの Web の録音のまま。M20・M21 の実機の確認で、画面ロック中もほかのアプリを使っている間も送り続けられると分かったので、検証用に作った Swift の録音（「iOS アプリ」タブ）は #459 で消した（spec/mobile.md 11.3）
- いつもの Web の録音の状態を、ロック画面の Live Activity とダイナミックアイランドに出し、そこから一時停止・再開・終了できる（#453。iOS 16.1 から、ボタンは iOS 17 から。録音は Web のまま。spec/mobile.md 11.5）
- ホーム画面のウィジェット（小）・ロック画面のウィジェット（円）・「録音を始める」（ショートカット・Siri、iOS 18 からはコントロールセンターも）から、アプリを開いていつもの Web の録音を始められる（#454。録音するのは最後に開いていたプロジェクト。spec/mobile.md 11.6）。ホーム画面のウィジェットに録音中・前回の録音を出すには App Group が要る（下の「設定」の 2）
- 検証用。ストアには出さない。クラウド版・Android は対象外

## 必要なもの

- Mac と Xcode（Xcode 27.2 で確かめた）。CocoaPods は要らない（依存は Swift Package Manager）
- Node.js 24
- 実機に入れるなら Apple ID（無料のものでよい）と、iPhone を Mac につなぐケーブル
- ホスト（`server/` が動く PC）に、iPhone から https で届く URL（Tailscale の `https://<端末名>.<tailnet>.ts.net` など）

## 設定

開く URL は Git に入れない。リポジトリは公開しているので、ホストの URL・端末名をコミットしない。

1. `.env.example` を `.env.local` に写し、`RW_SERVER_URL` を書き換える

    ```sh
    cp .env.example .env.local
    ```

    環境変数 `RW_SERVER_URL` があれば、そちらが優先される。`RW_SERVER_URL` がないと、アプリは同梱の `web/dist` を開くだけでホストにはつながらない（`cap sync` のときに警告が出る）

2. 実機に入れるなら、署名の設定を `ios/App/Local.xcconfig` に書く（Git に入れない）

    ```sh
    cp ios/App/Local.xcconfig.example ios/App/Local.xcconfig
    ```

    - `DEVELOPMENT_TEAM` に Team ID（Xcode の Settings → Accounts でチームを選ぶと出る 10 文字）を書く
    - 無料の Apple ID（Personal Team）は、Accounts に Team ID が出ないことがある。そのときは「キーチェーンアクセス」で「Apple Development: …」の証明書を開き、「組織単位」の 10 文字を使う（証明書が無ければ、先に Accounts の「Manage Certificates…」で ＋ → Apple Development を作る）
    - 無料の Apple ID で `dev.studiotakumi.remotewhisper` が使えないときは、`RW_APP_BUNDLE_IDENTIFIER` を自分用に変える（Widget Extension の Bundle ID は、この後ろに `.widgets` を付けたものになる。前に `PRODUCT_BUNDLE_IDENTIFIER` を書いていたら `RW_APP_BUNDLE_IDENTIFIER` に書き換える）
    - Xcode の「Signing & Capabilities」で Team を選ばない。`project.pbxproj` に Team ID が入り、コミットに紛れ込むため
    - ホーム画面のウィジェットに録音中・前回の録音を出すときだけ、`RW_APP_GROUP`（`group.` で始まる ID）と `RW_APP_GROUP_ENTITLEMENTS = AppGroup.entitlements` の 2 行を書く。App と Widget Extension に App Group のエンタイトルメントが付く。無料の Apple ID（Personal Team）では App Group を使えないことがあり、そのときは署名で失敗するので、2 行を消せば今までどおり入れられる（ウィジェットはいつも待機中の見た目になり、前回の録音は出ない）。App Group の ID も個人の識別子なのでコミットしない

### http を開けるのは Debug のビルドだけ

iOS は既定で http を開かない（ATS）。開発用の Vite（`http://localhost:5190`）を開けるよう、Debug のビルドだけ ATS の例外を足している（Build Phases の「Allow http in Debug」が、できあがった Info.plist に `NSAllowsLocalNetworking` を足す）。開けるのは localhost・`.local` などのローカルの宛先だけで、Release は https の URL しか開けない。

## ビルド

```sh
cd mobile
npm ci
(cd ../web && npm ci && npm run build)   # webDir の ../web/dist を作る（中身は表示に使わないが、cap sync が要る）
npx cap sync ios                         # .env.local の URL を ios/App/App/capacitor.config.json に書く
```

`.env.local` を書き換えたら、もう一度 `npx cap sync ios` してからビルドする。

### シミュレーターで動かす

```sh
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot "iPhone 17"
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted dev.studiotakumi.remotewhisper
```

シミュレーターはマイクの入力がなく録音を始められないので、Live Activity の見た目は Debug のビルドで見本を出して確かめる（`paused` で一時停止中）。ほかのアプリに切り替えるとダイナミックアイランドに出る。`simctl io` で撮るときは `--mask=black` を付けないとダイナミックアイランドが写らない

```sh
xcrun simctl launch booted dev.studiotakumi.remotewhisper -RWLiveActivityPreview recording
# 文字起こしの見本を替える: 続けて long（長い区切りが続く）・short（短い区切りが続く）・english（英数字が多い）
xcrun simctl launch booted dev.studiotakumi.remotewhisper -RWLiveActivityPreview recording long
```

### 実機で Live Activity が出ないとき

Safari の Web インスペクタ（Mac の Safari →「開発」→ 端末名 → アプリの画面）でコンソールを開き、`[LiveActivity]` で絞る。録音を始めたときの start の結果だけが出る（毎回の update では出ない）。出せないまま録音を続けても、同じ理由は 1 つのセッションにつき 1 回だけ（出し直しは、状態が変わったときと、行が変わって 60 秒以上たったときだけ）。

| 出力 | 原因 |
|---|---|
| `[LiveActivity] not shown: not-allowed` | 設定 → アプリ →「Live Activity」が許可されていない |
| `[LiveActivity] not shown: ios-too-old` | iOS が 16.1 より前 |
| `[LiveActivity] not shown: request-failed (…)` | ActivityKit が断った（同時に出せる数の上限など。`…` が詳細。Xcode のコンソールにも `Activity.request failed` が出る） |
| `[LiveActivity] start failed: …` | プラグインの呼び出しが失敗した |
| 何も出ない | 出せている。または画面が古く、アプリの中の判定（`isNativeApp()`）に入っていない |

ホーム画面のウィジェットの録音中の見た目も、同じように見本を出す（`paused`・`idle`（前回の録音あり）・`clear` も）。ウィジェットに録音中を渡すには App Group が要るので、シミュレーターでもその場の署名で App Group を付けてビルドする（`CODE_SIGNING_ALLOWED=NO` ではエンタイトルメントが付かない。ID は何でもよい）。ウィジェットはホーム画面を長押し →「編集」→「ウィジェットを追加」で置く

```sh
xcodebuild ... -derivedDataPath build CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= \
  RW_APP_GROUP=group.com.example.remotewhisper RW_APP_GROUP_ENTITLEMENTS=AppGroup.entitlements build
xcrun simctl launch booted dev.studiotakumi.remotewhisper -RWWidgetPreview recording
```

シミュレーターの名前は `xcrun simctl list devices` で選ぶ。開発用のサーバーと Vite を開くなら、`RW_SERVER_URL=http://localhost:5190`（シミュレーターの localhost は Mac）にして、サーバーを `--port 8010 --mock`、Vite を `REMOTE_WHISPER_SERVER=http://localhost:8010 npx vite --port 5190` で起動しておく。

### テスト

```sh
cd ios/App
xcodebuild test -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO
```

### 実機に入れる

1. 上の「設定」の 1・2 をし、「ビルド」の `npm ci`・web の build・`npx cap sync ios` もする（URL は iPhone から届く https のもの）
2. iPhone のデベロッパモードをオンにする：「設定 → プライバシーとセキュリティ → デベロッパモード」をオンにして再起動（iOS 16 から。初めて Mac につないだときにだけ要る）
3. `npx cap open ios`（Xcode が開く）
4. iPhone をつなぎ、上の実行先に選んで ▶（Run）
5. 初回は iPhone の「設定 → 一般 → VPN とデバイス管理」で、自分の Apple ID の開発元を信頼する

無料の Apple ID で入れたアプリは、7 日間で起動できなくなる。そのときは同じ手順で入れ直す。

### ログを見る

録音に使うマイクの固定（docs/spec/mobile.md 11.7）は、固定した・外した・選んだマイクが見つからないことを、今の入力と一緒に `[MicInput]` を付けて出す。次のどちらかで `[MicInput]` と入れて見る。

- Xcode から Run しているとき：下のコンソールの検索欄（Filter）に入れる
- つないでいないときに試したあと：iPhone を Mac につなぎ、Console.app の左で iPhone を選び、「ストリーミングを開始」してから検索欄に入れる（ストリーミング中に起きたことだけ出るので、試す前に始めておく）

## 中身

| パス | 中身 |
|---|---|
| `capacitor.config.ts` | アプリ ID（`appId`。iOS の Bundle ID の初期値）・名前・`webDir`・`server.url`（`.env.local` か環境変数から） |
| `ios/App/App.xcodeproj` | Xcode のプロジェクト（`npx cap add ios` で作ったもの） |
| `ios/App/App.xcconfig` | Bundle ID・App Group など。`Local.xcconfig` があれば読む |
| `ios/App/Widgets.xcconfig` | Widget Extension の Bundle ID（アプリのものの後ろに `.widgets`）。`App.xcconfig` を読む |
| `ios/App/AppGroup.entitlements` | App Group のエンタイトルメント（`Local.xcconfig` に書いたときだけ付く） |
| `ios/App/App/MainViewController.swift` | アプリの中だけのプラグイン（Live Activity・ウィジェットからの頼みごと・マイクの固定）を登録する画面 |
| `ios/App/App/LiveActivity/` | Live Activity のプラグイン（JS 向けの API は spec/mobile.md 11.5） |
| `ios/App/App/AppEntry/` | ウィジェット・App Intents から開いたときの頼みごとのプラグインと、ショートカット（spec/mobile.md 11.6） |
| `ios/App/App/HomeWidget/` | ホーム画面のウィジェットに録音の状態を渡すところ |
| `ios/App/Shared/` | App と Widget Extension の両方に入れるもの（Live Activity の中身・ボタン、ウィジェットの状態、ディープリンク、「録音を始める」） |
| `ios/App/Widgets/` | Widget Extension（Live Activity・ダイナミックアイランド・ホーム画面とロック画面のウィジェット・コントロールの見た目） |
| `ios/App/AppTests/` | Live Activity・ウィジェット・マイクの固定のテスト（XCTest） |
| `ios/App/CapApp-SPM/Package.swift` | Capacitor が管理する Swift Package（`cap sync` が書き直すので手で変えない） |

`ios/App/App/public`・`capacitor.config.json`・`config.xml` は `cap sync` が作るので Git に入れない（`ios/.gitignore`）。
