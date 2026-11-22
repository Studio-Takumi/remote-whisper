# 11. iOS アプリ

> [仕様書の目次](README.md)

iOS の PWA は、画面ロック中やバックグラウンドで録音を続けられない。ネイティブアプリにすればそれができるかを、最小の形で確かめる（#438）。この章はその検証用のアプリの決めごと。PR を 3 つに分けて作った（PR1：土台、PR2：録音のプラグイン、PR3：web からの呼び出し）。その後、実機の確認（M20・M21）で Web の録音で足りると分かり、Swift の録音は #459 で消した（11.3 節）。

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
- URL はリポジトリに入れない（公開しているため）。環境変数 `RW_SERVER_URL` か、Git に入れない `mobile/.env.local` から `capacitor.config.ts` が読み、`cap sync` のときにアプリの中の設定に書く。ないときは同梱の `web/dist` を開く（警告を出す）。そのときは画面のオリジンが `capacitor://localhost` になり、接続先の画面が出る（11.8 節）
- 本番の URL は Tailscale の https の前提。http を開ける ATS の例外は **Debug のビルドだけ** に足す（ビルドの途中で、できあがった Info.plist に `NSAllowsLocalNetworking` を足す。開けるのはローカルの宛先だけ）。開発用の Vite（`http://localhost:5190`）をシミュレーターで開くのに使う
- 署名の個人の値（Team ID・自分用の Bundle ID）は、Git に入れない `ios/App/Local.xcconfig` に書く。`project.pbxproj` には入れない
- safe area（ノッチ・ステータスバーの領域）：アプリの中で開くと上のバーがステータスバーに重なっていた（PR1。WebView の `contentInset` では fixed の要素は動かないので直らない）。web/ 側で、アプリの中でだけ `env(safe-area-inset-*)` の余白を当てて直した（11.4 節）

## 11.3 録音（Swift の録音は作らない）

録音はアプリの中でも、いつもの Web の録音（`getUserMedia`）のまま。M20・M21 の実機の確認で、Web の録音は画面ロック中もほかのアプリを使っている間も送り続けられ、割り込み（#447）・閉じたとき（#448）・マイクの選択（#449）も直せると分かった。そのため、#438 で検証用に作った Swift の録音プラグイン（`Recorder`・録音ファイル・「iOS アプリ」タブ）は #459 で消した。録音しながら Swift で送る案（#439）も要らなくなった。

- `Info.plist` の `UIBackgroundModes: audio`（バックグラウンドで音を扱い続ける）とマイクの許可の文言（`NSMicrophoneUsageDescription`）は、Web の録音で使うので残している
- ネイティブが録音に関わるのは、表示と入り口（11.5・11.6 節）とマイクの固定（11.7 節）だけ

## 11.4 web からの呼び出し

アプリの中で開いているときだけ、ネイティブの機能（Live Activity・ウィジェット・マイクの固定）を呼ぶ。ブラウザ版（Safari・PWA を含む）の画面・動き・最初に読むファイルは変えない。コードは `web/src/features/native/`。

### 見分け方とコードの分け方

- **アプリの中かどうかは `window.Capacitor?.isNativePlatform()` で見る（`nativePlatform.ts`）。** Capacitor が画面の読み込み前に `window.Capacitor` を差し込むので、`@capacitor/core` を読み込まずに分かる
- **ネイティブを呼ぶコード（`@capacitor/core`。プラグインの登録・SystemBars）は `nativeBridge.ts` にだけ置き、dynamic import で読み込む。** ブラウザ版では読み込まれない（別のチャンク `nativeBridge-*.js`）。`@capacitor/core` は web/ の依存に入れ、版は `mobile/` と同じにそろえる
- 画面の部品（React）は `nativeBridge.ts` に置かない。`lazy` で別のチャンクにすると、ビルドが共通のランタイムを別のファイルに分け、ブラウザ版の最初に読むファイルが 1 つ増えるため（PWA が最初に取っておくファイルにも入らない）
- プラグインは Proxy なので、Promise の結果にそのまま渡さない（`then` を呼ばれ、ネイティブのメソッドとして呼びに行く）。関数で包んで呼ぶ

### 設定モーダル

- 設定モーダルのページは、アプリの中でもブラウザ版と同じ並び。かつては最後に「iOS アプリ」（`/settings/ios`）を足していたが、#459 で消した。アプリの中で `/settings/ios` を開いても（古いブックマークなど）、知らないページとして最初のページを開く

### safe area

- アプリの中で開いたときだけ `<html>` に `rw-native` を付け、`index.css` の `.rw-native` の下だけで余白を当てる。ブラウザ版の CSS と `index.html` の meta は変えない（Safari・PWA の見た目が変わるため）
  - 上のバー（`data-slot='top-bar'`）：上の余白に `env(safe-area-inset-top)` を足す。上に貼り付けて背景を塗っているので、ステータスバーの下まで塗れる。セッションのタブ・再生バーも上のバーの中にある（#463）ので、一緒に下がって隠れない。高さ（`--top-bar-height`）は余白だけが変わっても測り直す。余白は `--rw-safe-top`（`env(safe-area-inset-top)`）経由で当てる（Playwright で値を差し替えて確かめるため）
  - サイドバー（スマホの幅）と参考資料メニューなどのシート：上下に `env(safe-area-inset-top)`・`env(safe-area-inset-bottom)`。閉じるボタンも下げる
  - マイクボタンは前から `env(safe-area-inset-bottom)` を見ている
- `env()` は `viewport-fit=cover` のときだけ値が入る。`index.html` の meta に前から付いているが、付いていなければアプリの中でだけ足す
- ステータスバーの文字の色は、画面のテーマ（`<html>` の `.dark`）に合わせて Capacitor の `SystemBars.setStyle` で変える（既定は端末の外観に合わせるので、画面だけダークにすると文字が溶ける）。Capacitor 8 の SystemBars は iOS では余白を扱わないので、余白は CSS で当てる

### 確かめ方

- web のテスト（vitest）：ブラウザでは `nativeBridge`・`@capacitor/core` を読み込まないこと。アプリの中でも設定のページの並びがブラウザと同じで、`/settings/ios` が最初のページになること
- ブラウザ版が変わっていないこと：変更の前後で、Playwright で PC（1280 幅）とスマホ（390 幅）・ライトとダークの画面（最初の画面・新規セッション画面・セッション画面・サイドバー・設定モーダルの全部のタブ）を撮ってピクセルで比べる。`npm run build` の前後で、最初に読むファイル（`index.html` が読む JS・CSS）の数が変わらず、増えたチャンクが `nativeBridge-*.js` だけなことを見る

## 11.5 Live Activity

いつもの Web の録音（WebSocket で送る録音）の状態を、ロック画面の Live Activity とダイナミックアイランドに出し、そこから一時停止・再開・終了できるようにする（#453）。

### 方針

- **録音は Web のまま、ネイティブは表示と入り口だけ。** #438 の実機の確認で、アプリの中の Web の録音は画面ロック中も送り続けられると分かった（裏にいても JS が動く）。録音の処理を Swift に作り直さない（11.3 節）
- Live Activity のボタンは `LiveActivityIntent`（iOS 17 から）。アプリのプロセスで動くので、プラグインのイベントで web/ に伝え、マイクボタンと同じいつもの一時停止・再開・終了の処理（ストアの `pauseRecording`・`resumeRecording`・`stopRecording`）を通す
- 版：アプリは iOS 15 から（変えない）。Live Activity は iOS 16.1、ボタンは iOS 17 から（`@available` で分ける）。16.1 より前はプラグインが何もせず `{ shown: false }` を返す。16.1〜16.x はボタンのない Live Activity を出す。ActivityKit・AppIntents は弱いリンクになる（iOS 15 でも起動できる）
- ブラウザ版（Safari・PWA を含む）は変えない。web/ の呼び出しは `isNativeApp()` のときだけ動き、`nativeBridge-*.js` のチャンクにだけ入る（11.4 節の決まりのまま）

### 置き場所

| パス | 中身 |
|---|---|
| `mobile/ios/App/Shared/` | App と Widget Extension の両方に入れるもの。`RecordingActivityAttributes`・`RecordingActivityState`（ContentState）・ボタンの操作（`RecordingActivityAction`）・`LiveActivityIntent` の 3 つ |
| `mobile/ios/App/App/LiveActivity/` | JS 向けのプラグイン `LiveActivityPlugin`（受け渡しだけ）、出す・変える・終えるを持つ `LiveActivityController`、ActivityKit を呼ぶ `ActivityKitClient`、見た目を確かめる `LiveActivityPreview`（Debug だけ） |
| `mobile/ios/App/Widgets/` | Widget Extension（ターゲット `Widgets`）。Live Activity とダイナミックアイランドの見た目。ホーム画面・ロック画面のウィジェットとコントロール（#454）も同じ Extension に入れる（11.6 節） |
| `web/src/features/native/liveActivitySync.ts` | ストアを見てプラグインを呼び、ボタンの操作をストアのアクションに渡す |

- プラグインは `MainViewController` の `capacitorDidLoad()` で登録する。クラスは継承で重ねず、`LiveActivityPlugin` が `LiveActivityController` を持ち、`LiveActivityController` が `LiveActivityClient`（本物は `ActivityKitClient`、テストでは偽物）を持つ
- Widget Extension の Bundle ID はアプリのものの後ろに `.widgets`（`ios/App/Widgets.xcconfig`）。Team ID は App と同じく `Local.xcconfig` から読む。Extension の最低の版は iOS 16.1（それより前の端末では読み込まれない）
- アプリの `Info.plist` に `NSSupportsLiveActivities`

### 中身（ActivityKit）

- `RecordingActivityAttributes`（変わらないもの）：`sessionId` だけ
- `RecordingActivityState`（ContentState）：`phase`（`recording`・`paused`）・`startedAt`（経過時間が 0 だった時刻）・`elapsed`（秒）・`title`（セッション名）・`lines`（直近のリアルタイム文字起こしの区切り、古い順）
  - セッション名は録音中に仮のタイトル（途中の要約から作るもの）に変わるので、Attributes ではなく ContentState に持つ
  - 経過時間は毎秒 update しない。`startedAt = 今 − elapsed` にして、`Text(timerInterval:)` で端末に数えさせる。一時停止中は `pauseTime`（`startedAt + elapsed`）で止めて出す。表示は端末の形（1 時間までは `12:34`、超えたら `1:12:34`）
  - 区切り（`lines`）は、空のものを除き、新しいほうから合わせて 120 文字に届くまでだけ持つ（最大 12 区切り。1 区切りは 120 文字まで、長いときは後ろ、新しく話したところを残す）。ロック画面の 3 行は 60 文字ほどなので、短い区切りが続くときも埋まる。ActivityKit の中身の上限（4KB）には、最大でも 1.5KB ほどで収まる
  - **つなげて折り返すのは Swift（見る側）。** web/ は区切りを配列のまま、新しいほうから最大 12 個送る（`liveActivitySync.ts` の `LINES`）。区切りごとの色分け（新しい区切りだけ白）に境目が要るので、web/ でも Swift の中身（ContentState）でもつなげない。どこまで入るかは幅で決まり、web/ は幅を知らないので、切るのも Swift（`TranscriptJoin.fit`）。ホーム画面のウィジェットも、同じ `lines` を同じ `TranscriptText` で出す。前の版の置き場（直近の 1 行だけの `line`）も、`lines` に読み替えて読む（読めないと前回の録音も消えるため）

### JS 向けの API（`LiveActivity`）

型定義は `web/src/features/native/liveActivityTypes.ts`。

| メソッド | 引数 | 返り値 | |
|---|---|---|---|
| `start(o)` | `{ sessionId, state, elapsed, title, lines }` | `{ shown: boolean, reason?, message? }` | 同じセッションのものを出していれば中身を変えるだけ。別のセッションのものは終えてから出す。出せなかったら `shown: false` と理由 `reason`（`not-allowed`＝設定で許可されていない、`ios-too-old`＝iOS 16.1 より前、`request-failed`＝ActivityKit が断った。このとき `message` に詳細）。web/ は start の結果が `shown: false` のとき・プラグインが失敗したときに `[LiveActivity]` でコンソールに出す（毎回の update では出さない。同じ理由は 1 セッションに 1 回だけ。出せなかったあとの出し直しは、state・mic が変わったとき、または前回の start から 60 秒以上たったときだけ。#462） |
| `update(o)` | `{ state, elapsed, title, lines }` | `{ shown: boolean }` | 出していなければ何もしない。返事に `reason` が付くのは start だけ（web/ は update の結果を使わない） |
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

- ロック画面・録音中：左上に赤い点と経過時間（等幅）、右上にセッション名。直近の文字起こしを、区切りをつなげた 1 つの文章として 3 行に折り返す（下の「文字起こしの折り返し」）。下に「一時停止」と「終了」
- ロック画面・一時停止中：琥珀の一時停止の印と経過時間（琥珀）、セッション名、文字起こしの終わりの 1 行ぶん（薄く）。「再開」と「終了」
- ダイナミックアイランド（テーマによらず黒）：compact は左に赤い波形の印・右に経過時間、minimal は波形の印だけ。expanded はロック画面の録音中と同じ中身で、文字起こしは 2 行。一時停止中は印を琥珀の一時停止の印にする
- iOS 16.1〜16.x はボタンを出さない

#### 文字起こしの折り返し（#460）

- 区切りをつなげて 1 つの文章にする（日本語はそのまま、直前が英数字・記号で次が英数字のときだけ空白を入れる）。入りきらないぶんは、**全体の頭だけを「…」にして**、最後の 3 行ぶん（ダイナミックアイランドは 2 行、一時停止中は 1 行）が続けて読めるようにする。区切りごとに頭を「…」にしない
- 色は、いちばん新しい区切りだけ濃く（ロック画面のライトは黒・ダークは白、ダイナミックアイランドは白）、それより前は灰色。一時停止中は全体を灰色にする
- 切るのは `TranscriptJoin.fit`。SwiftUI の `truncationMode(.head)` は複数行だと最後の行の頭だけを省略して途中から読めなくなるので使わない。幅の見積もりで、新しいほうから入れていき、入りきらない区切りは後ろから入るぶんだけ残す（「…」の直後が読点・句点なら削る）。見積もりは広いほうに寄せる：全角 1、半角は小文字 0.55・大文字と数字 0.7・空白 0.3・そのほか 0.6。予算は「行数 × 1 行の幅 − 1（「…」）− 2 × 折り返す回数（行数 − 1。禁則・英単語の折り返しの余裕）」（`TranscriptJoin.budget`）。1 行の幅は狭い端末に寄せ、ロック画面・ダイナミックアイランドは 18 文字、ホーム画面の小は 7 文字（3 行で予算 49・16）
- **見積もりが外れても、いちばん新しい区切りの末尾を省略しない。** `TranscriptText` は `minimumScaleFactor(0.8)` で少し縮めて収め、文字サイズの設定（Dynamic Type）は `xLarge` までに抑える（それ以上は大きくならない）。縮めても収まらないほど外れたときだけ、最後の行の末尾が省略される（ふつうは起きない見積もりにしてある）
- ロック画面の色（ライト・ダーク）は iOS が決める外観に従う（端末の設定ではなく、ロック画面の壁紙などで暗い外観になることがある）

### 確かめ方

- Swift のテスト（XCTest。`AppTests/LiveActivityTests.swift`）：ContentState の作り方（経過時間の起点・一時停止の時刻・区切りの持ち方・長い区切り・4KB に収まること）、区切りのつなぎ方と折り返し（`TranscriptJoin`）、JS の引数の読み方、`LiveActivityController` の状態の移り変わり（偽物の `LiveActivityClient` で、出す・変える・終える・別のセッション・許可されていない）
- web のテスト（vitest。`liveActivity.test.ts`）：ブラウザでは `nativeBridge`・`@capacitor/core` を読み込まないこと。偽物のプラグインで、start・update・end の順と中身、録音中のセッションが変わったときの start、マイクの状態の変化での update、出せなかった・失敗したときの start のし直し、行の間引き、止めたら待っていた更新を捨てること、ボタンのイベントでいつもの一時停止・再開・終了が呼ばれること
- 見た目：シミュレーターはマイクの入力がなく録音を始められないので、Debug のビルドの起動の引数 `-RWLiveActivityPreview recording`（または `paused`）で見本を出す（`LiveActivityPreview`。Release には入らない）。続けて `long`（長い区切りが続く）・`short`（短い区切りが続く）・`english`（英数字が多い）を書くと文字起こしの見本を替える（#460）。ロック画面とダイナミックアイランドのライト・ダークを撮って比べる
- 実機：Web の録音で、ロック画面とダイナミックアイランドに出ること・ボタンで一時停止・再開・終了できること・録音を終えたら消えること・アプリを落としてから開き直したら残っていないこと

## 11.6 ウィジェットと App Intents

ホーム画面のウィジェット（小）・ロック画面のウィジェット（円）・「録音を始める」の App Intents（ショートカット・Siri・コントロールセンター）を足す（#454）。11.5 節と同じ方針で、**録音は Web のまま、ネイティブは表示と入り口だけ**。

### 方針

- iOS はアプリが前面にないとマイクを開けないので、ウィジェット・App Intents から録音を始めるときは必ずアプリを開き、web/ に頼んで、マイクボタンと同じいつもの録音の開始（ストアの `startRecording`）を通す
- 版：アプリは iOS 15 から、Extension は 16.1 から（変えない）。App Intents（ショートカット・Siri）は iOS 16 から、コントロールセンターのコントロールは iOS 18 から（`@available` で分ける）
- ブラウザ版（Safari・PWA を含む）は変えない。web/ の呼び出しは `isNativeApp()` のときだけ動き、`nativeBridge-*.js` のチャンクにだけ入る（11.4 節の決まりのまま）

### 置き場所

| パス | 中身 |
|---|---|
| `mobile/ios/App/Shared/AppEntry.swift` | アプリを開いたときの頼みごと `AppEntryRequest`（録音を始める・セッションを開く・開くだけ）とディープリンクの読み書き、届いたものをプラグインに渡す `AppEntryInbox` |
| `mobile/ios/App/Shared/HomeWidgetState.swift` | ウィジェットに出す状態 `HomeWidgetState`、App Group の置き場 `HomeWidgetStore`、タイムラインの作り方 `HomeWidgetTimeline`、文言 `HomeWidgetText` |
| `mobile/ios/App/Shared/StartRecordingIntent.swift` | 「録音を始める」の `AppIntent` |
| `mobile/ios/App/App/AppEntry/` | JS 向けのプラグイン `AppEntryPlugin`（受け渡しだけ）、ショートカット・Siri に出す `RecordingShortcuts` |
| `mobile/ios/App/App/HomeWidget/` | 置き場に書いてウィジェットに知らせる `HomeWidgetWriter`、見た目を確かめる `HomeWidgetPreview`（Debug だけ） |
| `mobile/ios/App/Widgets/` | `HomeWidget`（小）・`LockScreenWidget`（円）・`StartRecordingControl`（コントロール）・アプリのアイコンの印 `AppMark`・色 `Palette` |
| `web/src/features/native/appEntrySync.ts` | プラグインのイベントを受けて、いつもの録音の開始・セッションを開く処理を呼ぶ。最後に開いていたプロジェクトを覚える |

- `AppEntryPlugin` は `MainViewController` で `LiveActivityPlugin` と並べて登録する。ウィジェットへの状態の書き込みは、`LiveActivityPlugin` が持つ `HomeWidgetWriter` がする（web/ からの start・update・end をそのまま使い、web/ から送るものは増やさない）
- `SceneDelegate` が、開いた URL（`remotewhisper://`）を `AppEntryInbox` に渡す

### アプリを開く入り口（ディープリンク・App Intents）

| 入り口 | 開き方 | web/ に伝えること |
|---|---|---|
| ホーム画面のウィジェット・待機中 | `remotewhisper://record` | `record` |
| ホーム画面のウィジェット・録音中 | `remotewhisper://session/<セッションの ID>` | `session` |
| ロック画面のウィジェット（円） | `remotewhisper://open` | なし（開くだけ） |
| ショートカット・Siri・コントロール | `StartRecordingIntent`（`openAppWhenRun`） | `record` |

- URL のスキームはアプリの `Info.plist` の `CFBundleURLTypes` で `remotewhisper`
- **外から開かれても確かめない。** ほかのアプリや Safari のページが `remotewhisper://record` を開いても（Safari では「開きますか」の確認のあと）、アプリは確かめずに最後に開いていたプロジェクトで録音を始める。検証用でストアに出さないので、今はこのままにする
- アプリを開いた直後は画面とプラグインがまだないので、`AppEntryInbox` が最後の 1 つを取っておき、プラグインが読み込まれたら渡す。プラグインは `retainUntilConsumed` で送り、web/ が聞き始めたときに届く

JS 向けの API（`AppEntry`。型は `web/src/features/native/appEntryTypes.ts`）はイベントだけ。

| イベント | 中身 | いつ |
|---|---|---|
| `entry` | `{ kind: 'record' }` か `{ kind: 'session', sessionId }` | ウィジェット・App Intents からアプリを開いた |

### web/ の動き

- 起動したとき（`main.tsx` の `startAppEntry`）、アプリの中でだけ `nativeBridge` を読み込み、`AppEntrySync` で見始める
- **最後に開いていたプロジェクト**：開いているプロジェクト（`selection.projectId`）が変わるたびに `localStorage` の `rw.ios.lastProject` に書く（アプリの中だけ）
- `entry` が届いたら、プロジェクトの一覧と設定を読み込むまで待ってから（`projectsLoaded`・`settingsLoaded`）処理する。待っている間に届いたものは後のものだけ残し、30 秒たっても読み込めなければ捨てる（つながってから急に録音が始まらないように）
- `record`
  - 設定モーダルを開いていたら閉じる（シミュレーターで、設定モーダルを開いたままウィジェットを押しても、閉じたあとの履歴の戻り（`popstate`）とぶつからずに 1 回だけ録音が始まることを確かめた）
  - 録音中なら、新しく始めずに録音中のセッションを開く（`showRecordingSession`）
  - 参加中（#241・#357。`joined` がある）なら、新しく始めずに参加中のセッションを開く（`selectSession`）。参加中は `recordingState` が `idle` のままなので、確かめないと、もう一つマイクを開いて録音を始めてしまう（iOS では後から開いたマイクが参加している音源を止めることもある）
  - 録音するプロジェクトは、開いているもの → 最後に開いていたもの（今もあれば）。そのプロジェクトの新規セッション画面にしてから、いつもの `startRecording` を呼ぶ（セッションを開いたままだと、新規セッション画面に切り替えるだけになるため）
  - プロジェクトがない（1 つもない・覚えていたものが消えた）ときは選ばずに `startRecording` を呼び、いつもの「録音するプロジェクトをメニューから選んでください」を出す
- `session`：録音中のセッションなら `showRecordingSession`、ほかはそのセッションを開く（`selectSession`）。見つからなければ何もしない

### ウィジェットへの状態の渡し方（App Group）

- アプリが App Group の共有の置き場（`UserDefaults(suiteName:)`）に `HomeWidgetState` を JSON で書き、`WidgetCenter.reloadTimelines(ofKind:)` で知らせる。ウィジェットはそれを読む
  - `recording`：セッションの ID・`phase`（`recording`・`paused`）・`startedAt`（経過時間が 0 だった時刻）・`elapsed`・セッション名・直近の文字起こしの区切り（`lines`。Live Activity と同じもの）・最後に書いた時刻（`updatedAt`）・録音を始めた・一時停止・再開した時刻（`changedAt`）
  - `last`（前回の録音）：セッション名・長さ・終えた時刻
- 書くのは `LiveActivityPlugin` に届く web/ の呼び出しのとき（Live Activity を出せたかどうかによらない）
  - `start`・`update`：`recording` を書く（置き場にはいつも書く）。作り直す（`reloadTimelines`）のは次のとき。作り直せる回数には限りがあり、裏で使い切ると録音を終えたときの作り直しも落ちて、録音中の見た目が残るため
    - すぐ：録音を始めた・別のセッションに替わった・一時停止・再開・セッション名が変わった・経過時間の合わせ直し（マイクが止まった・戻った。#447）
    - 行だけの変化：前に作り直してから 30 秒より後のときだけ。それより前は待たせておき、30 秒を過ぎてから届いた次の `update`（経過時間だけのものでも）で作り直す
    - 経過時間だけの変化（端末が数えている）：作り直さない
  - 前と違うセッションの `start` が来たら、前のものは `last` に移さずに上書きする（前のものは、終えたときの `end` で `last` になっている）
  - `end`：`recording` を `last` に移し、すぐ作り直す（長さは、録音中なら終えた時刻 − `startedAt`、一時停止中なら `elapsed`）。録音していないとき（読み込み直したときの片付け）は何もしない
  - アプリを開いたとき（プラグインの `load()`）：前にアプリが落とされて残った `recording` を、最後に書いた時刻で終えたことにして `last` に移す。Debug の見本（`-RWWidgetPreview`）はこのあとに書く
  - アプリが前面に戻ったとき（`UIApplication.didBecomeActiveNotification`）：一度作り直す。前面での作り直しは回数に数えられないので、裏で間引いた・落ちた作り直しをここで取り戻す
- タイムラインは 1 つ（録音中も経過時間は端末が数える）。録音中は、録音を始めた・最後に一時停止・再開した時刻（`changedAt`）から 8 時間たった時刻に待機中に切り替える（アプリが落とされて書かれなくなったもの。Live Activity が出続ける長さと同じ）。行の変化を起点にしないので、無音が続いて行が変わらないだけでは待機中にならない。一時停止・再開をせずに 8 時間を超えて録り続けると、録音中でも待機中の見た目になる
- **App Group は `Local.xcconfig` に ID を書いたときだけ使う。** 無料の Apple ID（Personal Team）では使えないことがあるため。`RW_APP_GROUP`（ID）と `RW_APP_GROUP_ENTITLEMENTS = AppGroup.entitlements` の 2 行を書くと、App と Extension にエンタイトルメント（`com.apple.security.application-groups`）が付き、ID が両方の `Info.plist` の `RWAppGroup` に入る。書かなければエンタイトルメントは付かず、今までの署名のまま入れられる
- App Group を使っていない（ID がない・置き場が開けない）ときは、ウィジェットはいつも待機中の見た目で、前回の録音の行を出さない。押せば録音を始める（録音中なら、録音中のセッションが開く）

### 見た目

匠が Pencil で作った採用案（ライトとダーク）。色は 11.5 節と同じ（録音開始＝青 `#3B82F6`）。

- ホーム画面・待機中（案A）：左上に「Remote Whisper」、右上にクラウドの印。真ん中に青い丸のマイクのボタン、下に「録音する」と前回の録音（「前回 11/19 3限 · 1:28:40」。セッション名が長いときは名前だけ省略して長さは残す。セッション名がなければ日付）
- ホーム画面・録音中（案B）：左上に赤い点と経過時間（等幅）、真ん中に直近の文字起こし（Live Activity と同じ出し方で 3 行まで。「」は付けない。いちばん新しい区切りだけ濃く、前は灰色。長いときは全体の頭を「…」にする）、下に文書の印とセッション名。一時停止中は印を琥珀の一時停止の印にし、経過時間も琥珀、行を薄くする
- ロック画面（円）：アプリのアイコンの印（「>」と波形とカーソル）。色はロック画面に合わせて iOS が付ける
- コントロール：マイクの印と「録音する」

### 確かめ方

- Swift のテスト（XCTest。`AppTests/HomeWidgetTests.swift`・`AppTests/AppEntryTests.swift`）：置き場の読み書き、`HomeWidgetWriter`（始める・行の更新・行だけの変化の間引き・経過時間だけでは作り直さない・一時停止とセッション名と終えたときはすぐ作り直す・前面に戻ったときの作り直し・8 時間の起点（`changedAt`）・別のセッションの start で上書き・終える・読み込み直しの片付けで前回の録音を消さない・アプリを開いたときの片付けと見本の順・置き場がないとき）、タイムライン（置き場がない・待機中・録音中と 8 時間後の切り替え・行が最近でも起点から 8 時間で切り替え・無音が続いても切り替えない）、文言、ディープリンクの読み書き、`AppEntryInbox` の取っておきと受け渡し
- web のテスト（vitest。`appEntry.test.ts`）：ブラウザでは `nativeBridge`・`@capacitor/core` を読み込まないこと。偽物のプラグインで、最後に開いていたプロジェクトを覚えること、`record` でそのプロジェクトの新規セッション画面にしていつもの録音を始めること、プロジェクトがないとき、録音中のとき、参加中のとき、設定モーダルを開いていたとき、読み込みを待つこと・時間切れ、`session` でセッションを開くこと
- 見た目：シミュレーターでウィジェットを置いて撮る。録音中の見た目は、Debug のビルドの起動の引数 `-RWWidgetPreview recording`（`paused`・`idle`・`clear` も。recording・paused には続けて `long`・`short`・`english` も書ける）で見本を置き場に書く（`HomeWidgetPreview`。App Group を使っているときだけ。Release には入らない）。シミュレーターで App Group を使うには、`RW_APP_GROUP`・`RW_APP_GROUP_ENTITLEMENTS` に加えて `CODE_SIGN_IDENTITY=-`（その場の署名）でビルドする（`CODE_SIGNING_ALLOWED=NO` ではエンタイトルメントが付かない）
- 実機：App Group あり・なしの両方で、ウィジェットを押してアプリが開き録音が始まること、録音中・前回の録音の表示、ショートカット・Siri・コントロールセンターからの「録音を始める」

## 11.7 録音に使うマイクの固定

設定で選んだマイク（spec/ui.md 8 章「録音に使うマイク」。#449）で録っている途中にイヤホンをつなぐと、iOS が入力をイヤホンのマイクに切り替える（画面の表示は選んだマイクのまま。#458）。web（`getUserMedia`）からは止められないので、アプリの中でだけ、iOS の入力を選んだマイクに固定する。録音は今までどおり web/ の `getUserMedia`。

### 方針

- **WebKit の動き**（WebKit のソースで確かめた）：`enumerateDevices` の `label` は `AVAudioSessionPortDescription.portName`、`deviceId` の元は `uid`。`getUserMedia` で選んだ入力は WebKit が `[AVAudioSession sharedInstance] setPreferredInput:` するが、選び直すのはカテゴリを設定するときだけで、経路が変わったとき（`routeChangeNotification`）には選び直さない。そのため録音の途中でつないだイヤホンに切り替わる
- **アプリは `routeChangeNotification` を見て、選んだ入力に `setPreferredInput` し直す。** カテゴリ・モードは変えない（WebKit が録音のときに `PlayAndRecord`・`Default` にする。アプリが変えると WebKit の録音とぶつかる）
- **選んだマイクは名前（`label`）で伝え、iOS の入力の `portName` が同じものに固定する。** 内蔵マイク（`builtInMic`）に限らない（`label` が `portName` そのものなので、USB・有線のマイクも同じ方法で固定できる）。伝える名前は、覚えている名前ではなく**開いたマイクのトラックの今の名前**（`track.label`。空なら覚えている名前）。`deviceId` が同じまま名前だけ変わる（iOS の言語・AirPods の名前を変えた）と、覚えている名前では見つからないため
- 「OS に任せる」・選んだマイクが見つからず OS に任せて開いたときは `null` を伝え、**前の固定を外す**（今までどおり iOS が選ぶ。WebKit が前の `getUserMedia` でかけた固定も外れる）。内蔵を選んだあと「OS に任せる」に戻したときに固定が残らないようにするため
- 同じ名前の入力が複数あるときは、今録っているもの、なければ今の固定、なければ先に見つかったもの（web は `deviceId` で開いているので、録っているものが web で開いたものに近い）。複数あることはログに出す
- 選んだマイクがつながっていないときは何もしない（iOS が選んだ入力で録る）。つながって経路が変わったら固定する
- カテゴリが `PlayAndRecord` でない（録音していない）ときは固定し直さない（経路に入力がなく効かないため）。固定は録音を止めても外さないが、次に録音を始めたとき（カテゴリの変化・web からの選択）に固定する
- 固定し直しても iOS が受け付けず経路の変化が続くときのため、続けて固定し直すのは 3 回まで（`PreferredInputRetry`。装置がつながった・外れた、web から伝え直した、メディアサービスのリセット、選んだ入力で録れたときに数え直す）
- ブラウザ版（Safari・PWA）は変えない。録音の途中でイヤホンをつなぐと、ブラウザが入力をイヤホンのマイクに切り替えることがある

### 置き場所

- `mobile/ios/App/App/MicInput/`：`MicInputPlugin`（JS との受け渡しだけ）が `PreferredInput`（`AVAudioSession` の経路を見て固定する）を持つ。どの入力に固定するかは `PreferredInputChoice`（テストできるよう、`AVAudioSession` に触らない）。`MainViewController` で登録する
- web/：`micDevice.ts` の `openChosenMicrophone` が、マイクを開けたあとに `nativePlatform.ts` の `setNativeMicInput` を呼ぶ。アプリの中でだけ `nativeBridge.ts` を dynamic import してプラグインを呼ぶ（ブラウザ版では何もせず、`nativeBridge` も読み込まない）。伝えられなくても録音は続ける

### JS 向けの API（`MicInput`）

型定義は `web/src/features/native/micInputTypes.ts`。

| メソッド | 引数 | 返り値 | |
|---|---|---|---|
| `setPreferredInput({ label })` | `label: string \| null`（開いたマイクの名前。`null` は OS に任せる） | なし | マイクを開くたび（録音を始める・参加する・開き直す・選び直す）に呼ぶ。固定はアプリの中で覚え、次に呼ばれるまで続ける |

何をしたか（固定した・外した・見つからない・やめた）は `[MicInput]` を付けて NSLog に出す（mobile/README.md）。

### 確かめ方

- Swift のテスト（XCTest。`AppTests/PreferredInputTests.swift`）：OS に任せる（`null`・空）、イヤホンに切り替わったときに選んだ入力に固定する、選んだ入力で録れていても固定していなければ固定する、固定してあって録れていれば何もしない、内蔵以外の入力、同じ名前が複数あるとき、選んだ入力がつながっていないとき、固定し直す回数の上限と数え直し
- web のテスト（vitest。`micDevice.test.ts`）：ブラウザでは伝えず `nativeBridge` も読み込まないこと。アプリの中では、選んだマイクで開けたら開いたマイクの今の名前（覚えている名前が古いとき・許可の前に覚えている ID で開けたときも）、OS に任せたとき・見つからなかったときは `null` を伝えること。伝えられなくてもマイクは開けること
- 実機：内蔵マイクを選ぶ → イヤホンなしで録音を始める → 録音中にイヤホンをつなぐ → 内蔵のまま録れて精度が落ちないこと（`[MicInput]` のログで固定し直したことと今の入力を見る）。そのとき「マイクが止まりました」などの知らせが出ず、音が途切れないこと（固定し直すので経路が 2 回続けて変わる）。「OS に任せる」では今までどおりイヤホンに切り替わること。固定したまま録音を止めたあとも、アプリの中でセッションの音声をイヤホン・AirPods で聞けること

## 11.8 画面の同梱（案B）への準備（#440）

今のアプリは、ホストの画面を `server.url` で開く（案A。11.2 節）。将来、画面（`web/dist`）をアプリに同梱して開く（案B）ための準備だけをした。**まだ同梱には切り替えていない**。`server.url` で開いている間は、何も変わらない。

同梱すると画面のオリジンが `capacitor://localhost` になり、ホストと別のオリジンになる。そのため、API・WebSocket の URL を絶対 URL で組み立て、ホストと中間サーバー（relay）がこのオリジンを受け付ける必要がある。

### 見分け方と接続先

- **同梱しているのは、アプリの中（`isNativeApp()`）で、画面が http(s) で開かれていないとき**（`web/src/api/endpoint.ts` の `isBundled`）。`server.url` で開いたときは http(s) なので、ブラウザ版と同じに扱う
- 接続先（ホストかクラウド版の URL。パスのないオリジン）とモード（`direct`・`cloud`）は、同梱しているときだけ `localStorage` の `remote-whisper.appEndpoint` から読む（`web/src/features/native/appEndpoint.ts`）。起動の最初に同期で決める必要があるので、`nativeBridge` の dynamic import ではなく、`isNativeApp()` で分けた同期の読み出しにしている
- **モードは、同梱しているときはホスト名ではなく保存した値で決める**（`resolveEndpoint`）。保存するときは、入力した URL のホスト名がクラウド用のドメイン（`VITE_CLOUD_HOSTS`）ならクラウド版にする。同梱していなければ、今まで通り画面のホスト名で決める
- URL は `endpoint.ts` の `apiUrl`・`wsUrl`・`workerUrl`（と、それを使う `meUrl` など）で組み立てる。接続先がないとき（ブラウザ版・`server.url`）は、前と同じ相対 URL（WebSocket は画面の `location` から）。接続先があれば、その前に付けた絶対 URL（`https:` なら `wss:`）
  - 通しているもの：REST API（`api.ts`）・WebSocket（`connection.ts`）・アップロード（`upload.ts`）・セッションの音声（`SessionView`）・設定の選択肢（`options.ts`）・開発用のパネル・クラウド版のアカウント（`/me`・`/auth`）・登録（`/pair`）・録音の計測（`sendBeacon`）・お知らせ（`announcements.json`）

### 接続先の画面

- 同梱していて接続先がまだないときだけ、App がアプリの画面の代わりに「接続先」の画面（`AppEndpointSetup.tsx`）を出す。URL を入れて「つなぐ」で保存し、読み込み直す。`https://` を省くと `https://` にする。http(s) 以外・ユーザー名やパスワード・パス・`?`・`#` の付いた URL は受け付けない
- 設定のモーダルの左下（バージョンの下）に、今の接続先と「変える」を出す（同梱しているときだけ）。「変える」で保存を消して読み込み直し、接続先の画面に戻る
- ブラウザ版と `server.url` では、どちらも出さない（部品は最初のチャンクに入るが、描画しない。`lazy` にしないのは 11.4 節と同じ理由）

### ホストと中間サーバー

- **ホスト（8000 番）**：Origin の確認（api.md 7.5 節）で `capacitor://localhost` を許し、このオリジンにだけ CORS を返す（`APP_ORIGINS`。資格情報なし・preflight あり）。ブラウザの画面はこのオリジンにならないので、ほかのサイトからの CSWSH・DNS rebinding には使えない。8000 番は Cookie を使わないので、設定で止める項目は作っていない
- **中間サーバー**：`APP_ORIGINS`（wrangler の vars。カンマ区切り）にあるオリジンにだけ、`/h/` と `/me` で CORS を返す（資格情報なし。`Access-Control-Allow-Credentials` を付けない）。空にすれば止まる。**このオリジンからのリクエストでは、ログインセッションの Cookie を読まない**（ログインしていない扱い）。状態を変えるリクエストと WebSocket の Origin の確認（cloud.md 10.7 節）は変えていないので、Cookie で認める経路は前と同じく自分のオリジンの画面だけ
- `ionic://localhost` は許していない（Capacitor の iOS の既定は `capacitor://`。`iosScheme` を変えていない）

### 残っていること

- 同梱したときのクラウド版のログイン（システムのログイン画面とトークン）は #441。それまでは、同梱した画面からクラウド版にはログインできない
- 実機の WKWebView で、`capacitor://localhost` から http（Tailscale でない LAN）のホストにつなげるか（ATS・混在コンテンツ）は、同梱に切り替えるときに確かめる
- 同梱した画面の service worker（PWA の更新）・通知・画面の URL（`/s/<UUID>` など）の扱いは、同梱に切り替えるときに決める

### 確かめ方

- web のテスト（vitest）：`endpoint.test.ts`（同梱の見分け方・モードを保存した値で決める・絶対 URL の組み立て・ブラウザ版は相対 URL のまま）、`appEndpoint.test.ts`（URL のそろえ方・保存と読み出し・壊れた値）、`AppEndpointSetup.test.tsx`（接続先の画面・設定の接続先がブラウザ版では出ないこと）
- server のテスト（`test_host_check.py`）：`capacitor://localhost` からの API・WebSocket・preflight が通り、CORS に資格情報が付かないこと。ほかのオリジン（`capacitor://evil.example`・`ionic://localhost` を含む）は前と同じく 403 で、CORS も付かないこと
- relay のテスト（`appOrigin.test.ts`）：preflight と返事の CORS、Cookie があってもログインしていない扱いになること、ほかのオリジン・ほかのパスには付かないこと
- ブラウザ版が変わっていないこと：`npm run build` の前後で最初に読むファイル（`index.html` が読む JS・CSS）とチャンクの並びが同じこと。Playwright で PC・スマホの幅、ライト・ダークの最初の画面・サイドバー・設定モーダルを撮り、ピクセルで比べる
