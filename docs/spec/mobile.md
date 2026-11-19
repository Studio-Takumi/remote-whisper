# 11. iOS アプリ

> [仕様書の目次](README.md)

iOS の PWA は、画面ロック中やバックグラウンドで録音を続けられない。ネイティブアプリにすればそれができるかを、最小の形で確かめる（#438）。この章はその検証用のアプリの決めごと。PR を 3 つに分けて作り、この章も PR ごとに書き足す（PR1：土台、PR2：録音のプラグイン、PR3：web からの呼び出し）。

## 11.1 位置づけ

- **検証用。** 確かめたいのは「画面ロックのまま 30 分録れるか」「割り込み（電話・Siri）でどう動くか」「電池の減り方」。ストアへの提出・クラウド版・ログイン・通知・Android は対象外
- 置き場所はリポジトリ直下の `mobile/`。独立した npm のパッケージで、web/・server/・relay/ の CI・設定（tsconfig・lint・prettier）には入れない
- Capacitor 8（`@capacitor/core`・`@capacitor/ios`・`@capacitor/cli` を同じ版で固定）。iOS の依存は Swift Package Manager で入れる（CocoaPods は使わない）
- アプリ ID は `dev.studiotakumi.remotewhisper`（Capacitor はハイフンを許さない）。手元で変えるときは `ios/App/Local.xcconfig`
- 録音しながらサーバーへ送る（リアルタイム文字起こし）のは、この検証が通ったら別の Issue で

## 11.2 画面の開き方（`server.url`）

- アプリは画面を持たず、セルフホスト版の画面（ホストの FastAPI が配信する `web/dist`）を Capacitor の `server.url` でそのまま開く。web/ のコピーは作らない
  - `webDir` は `../web/dist` を指す。表示には使わないが `cap sync` が要る
  - 開いた画面は普通のブラウザと同じく `/api/...`・`/ws` を同じオリジンで使う。iOS アプリのための API は足さない
- URL はリポジトリに入れない（公開しているため）。環境変数 `RW_SERVER_URL` か、Git に入れない `mobile/.env.local` から `capacitor.config.ts` が読み、`cap sync` のときにアプリの中の設定に書く。ないときは同梱の `web/dist` を開くだけになる（警告を出す）
- 本番の URL は Tailscale の https の前提。http を開ける ATS の例外は **Debug のビルドだけ** に足す（ビルドの途中で、できあがった Info.plist に `NSAllowsArbitraryLoads` を足す）。開発用の Vite（`http://localhost:5190`）をシミュレーターで開くのに使う
- 署名の個人の値（Team ID・自分用の Bundle ID）は、Git に入れない `ios/App/Local.xcconfig` に書く。`project.pbxproj` には入れない
- 分かっていること：今の画面は safe area（ノッチ・ステータスバーの領域）を見ていないので、アプリの中で開くと上のバーがステータスバーに重なる（PR1 のシミュレーターで確認。WebView の `contentInset` では fixed の要素は動かないので直らない）。直すなら web/ 側で `env(safe-area-inset-*)` を使う。検証の妨げにならなければ後回し

## 11.3 録音のプラグイン

PR2 で書く。予定は #438 の本文のとおり（AVAudioSession `.record` ＋ AVAudioEngine、Documents に少しずつ書く、`UIBackgroundModes: audio`、割り込みで止めて終わったら再開、録ったファイルの一覧、`UIFileSharingEnabled`）。

## 11.4 web からの呼び出し

PR3 で書く。予定は、アプリの中で開いているとき（`Capacitor.isNativePlatform()`）だけ検証用の録音の操作を出し、ネイティブ用のコードは dynamic import にしてブラウザ版のバンドルに入れないこと。
