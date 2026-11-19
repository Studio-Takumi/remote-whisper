# mobile（iOS アプリ・検証用）

画面ロック中やバックグラウンドでも録音できるかを確かめるための、iOS アプリの土台（#438。仕様は [spec/mobile.md](../docs/spec/mobile.md)）。

- セルフホスト版の画面を、アプリの中でそのまま開く（Capacitor の `server.url`）。web/ のコピーは持たない
- 録音だけを Swift のプラグインでやる（#438 の PR2 で足す）
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
    - 無料の Apple ID で `dev.studiotakumi.remotewhisper` が使えないときは、`PRODUCT_BUNDLE_IDENTIFIER` を自分用に変える
    - Xcode の「Signing & Capabilities」で Team を選ばない。`project.pbxproj` に Team ID が入り、コミットに紛れ込むため

### http を開けるのは Debug のビルドだけ

iOS は既定で http を開かない（ATS）。開発用の Vite（`http://localhost:5190`）を開けるよう、Debug のビルドだけ ATS の例外を足している（Build Phases の「Allow http in Debug」が、できあがった Info.plist に `NSAllowsArbitraryLoads` を足す）。Release は https の URL しか開けない。

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

### 実機に入れる

1. 上の「設定」の 1・2 をする（URL は iPhone から届く https のもの）
2. `npx cap open ios`（Xcode が開く）
3. iPhone をつなぎ、上の実行先に選んで ▶（Run）
4. 初回は iPhone の「設定 → 一般 → VPN とデバイス管理」で、自分の Apple ID の開発元を信頼する

無料の Apple ID で入れたアプリは、7 日間で起動できなくなる。そのときは同じ手順で入れ直す。

## 中身

| パス | 中身 |
|---|---|
| `capacitor.config.ts` | アプリ ID・名前・`webDir`・`server.url`（`.env.local` か環境変数から） |
| `ios/App/App.xcodeproj` | Xcode のプロジェクト（`npx cap add ios` で作ったもの） |
| `ios/App/App.xcconfig` | Bundle ID など。`Local.xcconfig` があれば読む |
| `ios/App/CapApp-SPM/Package.swift` | Capacitor が管理する Swift Package（`cap sync` が書き直すので手で変えない） |

`ios/App/App/public`・`capacitor.config.json`・`config.xml` は `cap sync` が作るので Git に入れない（`ios/.gitignore`）。
