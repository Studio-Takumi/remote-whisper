# mobile（iOS アプリ・検証用）

画面ロック中やバックグラウンドでも録音できるかを確かめるための、iOS アプリの土台（#438。仕様は [spec/mobile.md](../docs/spec/mobile.md)）。

- セルフホスト版の画面を、アプリの中でそのまま開く（Capacitor の `server.url`）。web/ のコピーは持たない
- 録音だけを Swift のプラグイン（`ios/App/App/Recorder/`）でやる。16kHz・モノラルの WAV を、ファイルアプリから見える `recordings` フォルダに書く
- 録音の操作は、アプリの中で開いたときだけ設定モーダルの最後のタブ「iOS アプリ」に出る（録音開始・録音停止・状態・録音ファイルの一覧。ファイルごとの「セッションを作る」で、今開いているプロジェクトに「音声ファイルから作る」と同じようにセッションを作る。spec/mobile.md 11.4）
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
    - 無料の Apple ID で `dev.studiotakumi.remotewhisper` が使えないときは、`PRODUCT_BUNDLE_IDENTIFIER` を自分用に変える
    - Xcode の「Signing & Capabilities」で Team を選ばない。`project.pbxproj` に Team ID が入り、コミットに紛れ込むため

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

シミュレーターの名前は `xcrun simctl list devices` で選ぶ。開発用のサーバーと Vite を開くなら、`RW_SERVER_URL=http://localhost:5190`（シミュレーターの localhost は Mac）にして、サーバーを `--port 8010 --mock`、Vite を `REMOTE_WHISPER_SERVER=http://localhost:8010 npx vite --port 5190` で起動しておく。

### テスト

```sh
cd ios/App
xcodebuild test -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO
```

本物のマイクで数秒録るテストは普段は飛ばす。回すときは、シミュレーターを起動してマイクを許可してから、`TEST_RUNNER_RW_MIC_TEST=1` を付けて上を実行する（Mac にマイクなどの入力の装置が要る。無いと `no-input` で失敗する）。

```sh
xcrun simctl boot "iPhone 17"
xcrun simctl privacy "iPhone 17" grant microphone dev.studiotakumi.remotewhisper
TEST_RUNNER_RW_MIC_TEST=1 xcodebuild test ...（上と同じ）
```

### 実機に入れる

1. 上の「設定」の 1・2 をし、「ビルド」の `npm ci`・web の build・`npx cap sync ios` もする（URL は iPhone から届く https のもの）
2. iPhone のデベロッパモードをオンにする：「設定 → プライバシーとセキュリティ → デベロッパモード」をオンにして再起動（iOS 16 から。初めて Mac につないだときにだけ要る）
3. `npx cap open ios`（Xcode が開く）
4. iPhone をつなぎ、上の実行先に選んで ▶（Run）
5. 初回は iPhone の「設定 → 一般 → VPN とデバイス管理」で、自分の Apple ID の開発元を信頼する

無料の Apple ID で入れたアプリは、7 日間で起動できなくなる。そのときは同じ手順で入れ直す。

### 録音のログを見る

録音のプラグインは、割り込みの始まりと終わり（理由・`shouldResume`）・入力の形式の変化・音声のセッションを有効にできなかったことなどを、`[Recorder]` を付けてログに出す。

- Xcode から Run しているとき：下のコンソールの検索欄（Filter）に `[Recorder]` と入れる
- つないでいないときに試したあと：iPhone を Mac につなぎ、Console.app の左で iPhone を選び、「ストリーミングを開始」してから検索欄に `[Recorder]` と入れる（ストリーミング中に起きたことだけ出るので、試す前に始めておく）

## 中身

| パス | 中身 |
|---|---|
| `capacitor.config.ts` | アプリ ID（`appId`。iOS の Bundle ID の初期値）・名前・`webDir`・`server.url`（`.env.local` か環境変数から） |
| `ios/App/App.xcodeproj` | Xcode のプロジェクト（`npx cap add ios` で作ったもの） |
| `ios/App/App.xcconfig` | Bundle ID など。`Local.xcconfig` があれば読む |
| `ios/App/App/MainViewController.swift` | アプリの中だけのプラグイン（録音）を登録する画面 |
| `ios/App/App/Recorder/` | 録音のプラグイン（JS 向けの API は spec/mobile.md 11.3） |
| `ios/App/AppTests/` | 録音のプラグインのテスト（XCTest） |
| `ios/App/CapApp-SPM/Package.swift` | Capacitor が管理する Swift Package（`cap sync` が書き直すので手で変えない） |

`ios/App/App/public`・`capacitor.config.json`・`config.xml` は `cap sync` が作るので Git に入れない（`ios/.gitignore`）。
