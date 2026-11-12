# Mac に入れて使う

Python・uv・cloudflared を自分で入れずに、`.dmg` 1 つで remote-whisper のホスト（文字起こしをする Mac）を使えるようにするものです（#292）。Apple シリコン（M1 以降）の Mac で、録音中の文字起こしを Mac の GPU（mlx-whisper。#276）でします。録音後の最終の文字起こし（WhisperX。話者分けを含む）は入っていません（初回の案内から入れます。後述）。

開発の手順（`uv run remote-whisper`）は今までどおり使えます。この `.dmg` は、リポジトリを持っていない人向けです。Windows 版は [install-windows.md](install-windows.md) です。

## 入っているもの

`Remote Whisper.app` の中（`Contents/Resources/app`）に、次のものが入っています。中の形は Windows の配布版と同じです（`server/src/remote_whisper/bundle.py`）。

- Python 3.11（python-build-standalone）と、`server/uv.lock` の通りの依存（mlx・mlx-whisper、faster-whisper（無音の判定に使う）、メニューバー用の pystray など）。`uv export` した固定の版とハッシュ（`--require-hashes`）で入れています
- 画面（ブラウザで開くフロント）
- cloudflared（クラウド版で、ホストを外から見えるようにするトンネル。版と SHA256 を固定して公式から取ったもの）
- `whisperx-requirements.txt`（WhisperX を後から入れるときの、版とハッシュを固定した一覧。#291）

`.app` は約 1.4GB、`.dmg` は約 430MB です。データ（プロジェクト・セッション・設定・ログ）は `~/.remote-whisper` にあり、**アプリを消しても消えません**。

## 動く Mac

- Apple シリコン（arm64）の Mac。Intel の Mac では動きません
- macOS 14（Sonoma）以降（mlx が macOS 14 から）
- ブラウザ（Chrome・Safari など。マイクの許可はブラウザが聞きます。アプリ自体はマイクを使わないので、アプリにマイクの許可は要りません）

## 手順（開発の道具が入っていない Mac で確かめる）

1. **ダウンロード**: 取得元は 2 つあります。どちらも、今は匠が使う前提です。
   - **Actions の artifact**（今の主な取り方）: リポジトリの Actions →「Package」の実行 → 下の Artifacts の `remote-whisper-mac-dmg` をダウンロードする。GitHub にログインしていないと取れず、**14 日で消え**、**zip に包まれて**くる（展開すると `remote-whisper-<版>-mac-arm64.dmg`）。「Run workflow」で、作るもの（`mac` を選ぶと Mac だけ）を選べます。
   - **Release**: `v*` のタグを push すると、Windows のインストーラと並んで、同じ `.dmg` が**下書き**のリリースに付く（公開されない）。
2. **入れる**: `.dmg` を開き、`Remote Whisper` を隣の「Applications（アプリケーション）」にドラッグする。`.dmg` の中から直接開くと、「アプリケーションフォルダに移してから開いてください」と出て起動しません（macOS が読み取り専用の仮の場所で動かすため）。入れ終えたら `.dmg` は取り出して消してかまいません。
3. **初めて開く（Gatekeeper の警告）**: 署名・公証をしていないので、そのままでは開けません。下の「Gatekeeper の警告の開き方」のとおりに開きます。2 回目からは、普通に開けます。
4. **起動**: アプリを開くと、メニューバー（画面の右上）にアイコン（「>」とカーソル）が出て、ブラウザで画面が開きます。Dock にはアイコンを出しません。動いているときにもう一度アプリを開くと、2 つ目は起動せず、画面をブラウザで開きます。
5. **Cloud に登録**: メニューバーのアイコンをクリック →「クラウド版にログイン」。ブラウザが開くので、ログインして、画面のコードが通知・メニューの行と同じかを確かめて承認する。登録できたら、メニューの「トンネル」が「つながっている」になる。
6. **録音**: ブラウザで Cloud の画面（またはメニューの「画面を開く」。既定は `http://127.0.0.1:8000/`）を開き、プロジェクトを作ってセッションで録音する。マイクの許可はブラウザが聞きます。
7. **文字起こし**: 話した内容が文字起こしで出る。**初回は Whisper のモデル（large-v3-turbo の mlx 版。約 1.6GB）のダウンロードがあるので、出るまでに数分かかります**（ダウンロード先は HuggingFace のキャッシュ `~/.cache/huggingface`）。
8. **アンインストール**: 下の「アンインストール」のとおり。データのフォルダ（`~/.remote-whisper`）が残っていることを確かめる。

## Gatekeeper の警告の開き方

`.app` に署名・公証（Apple Developer Program が要る）をしていないので、ダウンロードした `.dmg` から入れたアプリを初めて開くと、macOS が止めます。

- **macOS 15（Sequoia）以降**
  1. アプリを開く。「"Remote Whisper"は開いていません」（Apple はマルウェアが含まれていないことを検証できませんでした）と出るので、「完了」を押す
  2. 「システム設定」→「プライバシーとセキュリティ」を開き、下の方の「セキュリティ」に出ている「"Remote Whisper"は Mac を保護するためにブロックされました」の横の「このまま開く」を押す
  3. もう一度出る確認で「このまま開く」を押し、Mac のパスワード（または Touch ID）で許可する
- **macOS 14（Sonoma）**: Finder で「アプリケーション」の `Remote Whisper` を右クリック（control + クリック）→「開く」→ 出てきた確認で「開く」。出ないときは macOS 15 と同じく「プライバシーとセキュリティ」から開く。

### 開けないとき

- **中の Python（`python3.11`）についても同じ警告が出たとき**: アプリの中の Python も、ダウンロードした印（`com.apple.quarantine`）が付いたままなので、macOS の版によっては、アプリを許可したあとに Python にも警告が出ることがあります。そのときは、上と同じく「プライバシーとセキュリティ」で `python3.11` を「このまま開く」で許可して、アプリをもう一度開きます。
- **それでも開けないとき**: 「ターミナル」で、このアプリについたダウンロードの印だけを外すと開けます（ダウンロード元を信頼できるときだけ。ほかのアプリには使わない）。印を外すと、macOS はこのアプリを確かめなくなるので、**その前に、落とした `.dmg` が GitHub に置いたものと同じかを SHA256 で確かめます**。

  1. 手元の `.dmg` の SHA256 を出す

     ```sh
     shasum -a 256 ~/Downloads/remote-whisper-*-mac-arm64.dmg
     ```

  2. GitHub の値と比べる。Release から落としたときは、リリースの画面の `.dmg` の行に出る `sha256:…`（asset の digest。`gh release view <タグ> --json assets` の `digest` でも見られる）。Actions の artifact から落としたときは、Package の実行のログの「Build the app and the dmg」の最後に出る `SHA256` の行（artifact の zip を展開した中の `.dmg` と比べる）。**違っていたら開かずに消して**、落とし直す
  3. 同じなら、印を外す

     ```sh
     xattr -dr com.apple.quarantine "/Applications/Remote Whisper.app"
     ```

  「操作は許可されていません」と出るときは、「システム設定」→「プライバシーとセキュリティ」→「アプリケーションの管理」で「ターミナル」を許可してから、もう一度実行します。
- 「壊れているため開けません」と出るときも、上の `xattr` で直ります。

## ログイン時に起動

メニューバーのアイコン →「ログイン時に起動」で切り替えます（チェックが付いていれば有効。既定はオフ）。次にログインしたときから効きます。

- 有効にすると、`~/Library/LaunchAgents/io.github.studio-takumi.remote-whisper.plist` を置きます（launchd のユーザーのエージェント）。macOS が「バックグラウンド項目が追加されました」と知らせ、「システム設定」→「一般」→「ログイン項目と機能拡張」の「バックグラウンドでの実行を許可」に出ます（署名していないので、名前は `remote-whisper` と出ることがあります）。ここでオフにすると、ログイン時に起動しなくなります。
- ログイン時の起動では、ブラウザを開きません（メニューバーのアイコンだけ出ます）。
- オフにすると plist を消します。動いているサーバーは止めません。
- plist にはアプリの場所を書いています。アプリを別の場所に移したときは、チェックが外れて見えるので、もう一度押すと今の場所で書き直します。

## ポート番号と二重起動（#290）

Windows のショートカットと同じく、アプリは `--auto-port` を付けて起動します（ログイン時の起動も同じ）。

- 8000 番が他のアプリに使われているときは、8002〜8011 番を順に試して、空いている番号で起動します（8001 番はクラウド版のトンネル専用なので飛ばす）。通知に「ほかのアプリが 8000 番を使っていたため、○○ 番で起動しました」と出て、メニューの「画面を開く」はその番号の画面を開きます。使った番号は、データのフォルダの `port.json` に書きます。
- 同じデータのフォルダでサーバーが動いている間は `instance.lock` が取れないので、2 つ目は起動せず、動いている方の画面を開いて終わります（ログイン時に起動したあとに、Finder からアプリを開いたときなど）。
- 詳しくは [install-windows.md](install-windows.md) の「ポート番号と二重起動」と同じです。

## アンインストール

1. メニューバーのアイコン →「ログイン時に起動」のチェックを外す（付けていたとき）
2. メニューバーのアイコン →「終了」
3. 「アプリケーション」の `Remote Whisper` をゴミ箱に入れる

データ（`~/.remote-whisper`）と、Whisper のモデル（`~/.cache/huggingface` の `mlx-community/whisper-*`）は残ります。要らなければ、自分で消します。「ログイン時に起動」を外し忘れてアプリを消したときは、`~/Library/LaunchAgents/io.github.studio-takumi.remote-whisper.plist` を消します（残っていても、アプリがないので何も起動しません）。

## 新しい版に更新するとき

メニューバーから「終了」してから、新しい `.dmg` の `Remote Whisper` を「アプリケーション」にドラッグして置き換えます（データは残ります）。新しいアプリを初めて開くときに、もう一度 Gatekeeper の警告が出ます。**後から入れた WhisperX は、アプリを置き換えると消えます**。初回の案内（設定の「セットアップ」）から入れ直してください。

## Ollama・WhisperX・HuggingFace のトークン

- **Ollama**（要約・用語リスト）は同梱していません（代わりに LM Studio も使えます。下の「LM Studio を使う場合」）。入っていない（または動いていない）と、アイコンのカーソルが橙になり、要約は作りません。**文字起こしそのものは動きます**。初回の案内（#291）に、入れ方が出ます。
- **WhisperX**（浄書と話者分け）は同梱していません。初回の案内（設定の「セットアップ」）の「入れる」で、同梱の Python に `whisperx-requirements.txt`（版とハッシュを固定）で入れます。入れ先はアプリの中なので、アプリを置き換えると消えます。
- HuggingFace のトークンがないと、話者分けはしません。

### LM Studio を使う場合

要約と用語リストは、Ollama の代わりに [LM Studio](https://lmstudio.ai/) でも作れます（#327）。

1. [ダウンロードのページ](https://lmstudio.ai/download)から LM Studio を入れ、「アプリケーション」に置きます（`/Applications/LM Studio.app`）。
2. **サーバーを起動します。** LM Studio はアプリを開いただけではサーバーが動きません。LM Studio の「Developer」でサーバーをオンにするか、ターミナルで `lms server start` を実行します（`lms` が見つからなければ `~/.lmstudio/bin/lms`）。既定は `http://localhost:1234` です。
3. remote-whisper の画面の設定の「要約」で、「要約に使うアプリ」を「LM Studio」にして保存します。URL を変えたときは「LM Studio の URL」も直します。
4. LM Studio のサーバーの設定で認証（API トークン）を求めるようにしたときは、同じ「要約」の「LM Studio のトークン」に入れて保存します。トークンは画面に出ません（空のまま保存しても消えず、消すときは「消す」を押してから保存します）。
5. 設定の「セットアップ」の「要約のモデル」で、おすすめのモデル（`google/gemma-4-e4b`・`qwen/qwen3.5-2b`）を「取得」します（LM Studio がダウンロードします。Mac では MLX 版になることがあり、大きさは Windows の GGUF 版と違います）。LM Studio には取得を止める API がないので、途中で止めるときは LM Studio の画面から止めます。

LM Studio を選んでいる間は、メニューバーのアイコンと画面は LM Studio の状態だけを見ます。remote-whisper が載せたモデルだけを下ろし、LM Studio の画面で手で載せたモデルには触りません。

## 方式の選び方（Python ごと同梱した .app / py2app / PyInstaller）

Windows（#168）と同じく、python-build-standalone の Python をそのまま `.app` の中に置き、`uv.lock` の依存を入れる形にしました。`.app` の外側（`Info.plist`・起動用のスクリプト・アイコン）は `packaging/build-mac.sh` で手で組みます。理由:

- **mlx の Metal のライブラリが、そのまま動く**: mlx は `mlx/lib/libmlx.dylib` と、その隣の `mlx.metallib`（Metal のシェーダー）を、自分の場所から探して読みます。普通の site-packages の形なら手を入れずに動きます（同梱の Python で Metal の GPU が使えること、mlx-whisper で文字起こしができることを確かめました）。PyInstaller・py2app はライブラリを別の場所にまとめ直すので、`mlx.metallib` を見つけさせる設定（hook）が要り、mlx の版が上がるたびに壊れるおそれがあります。
- **依存を `uv.lock` のまま入れられる**: `uv export` した固定の版とハッシュで入れるので、開発の環境と食い違いません。Windows と同じビルドの考え方で済みます。
- **後から WhisperX を足せる**: 初回の案内（#291）は、同梱の Python に pip で WhisperX を入れます。PyInstaller・py2app の形には、後から pip で足せません。
- **子プロセスがそのまま動く**: 録音中の文字起こし（multiprocessing の spawn）と浄書（`python -m remote_whisper.final_transcribe_worker`）は、`sys.executable` の Python を子として動かします。普通の Python なのでそのまま動きます。
- 起動用のスクリプト（`Contents/MacOS/remote-whisper`）は、同梱の Python を `exec` で動かします。LaunchServices は Python のプロセスを `Remote Whisper.app` として扱う（`LSUIElement` で Dock に出さない、もう一度開いたら画面を開く）ことを確かめました。
- 代わりに、`.app` が大きくなります（mlx-whisper が要る torch・scipy・numba なども入るため。約 1.4GB）。
- 動かせる一番古い macOS は 14 です。ビルドする Mac の版によらず、macOS 14 向けの wheel（`MACOSX_DEPLOYMENT_TARGET=14.0`）を選んで入れます。

## わかっている制限

- 署名・公証をしていない（Gatekeeper の警告が出る）。配る相手が増えたら、Apple Developer Program での署名・公証を検討します。
- Apple シリコン（arm64）・macOS 14 以降だけ。
- WhisperX は、アプリの中（同梱の Python）に入れます。そのため、**管理者のユーザーが「アプリケーション」に入れたアプリを、標準ユーザーで使うときは、画面から WhisperX を入れられません**（アプリの中に書き込めず、失敗して元に戻ります）。入れるときは、アプリを入れた管理者のユーザーで一度開いて、初回の案内から入れます。
- 自動更新はない。新しい版は、`.dmg` からアプリを置き換える。
- Ollama は同梱しない。

## ビルドの仕方（開発者向け）

```sh
packaging/build-mac.sh                # packaging/out-mac/ に .app と .dmg ができる
packaging/build-mac.sh --no-dmg       # .app だけ
packaging/smoke-mac.sh "packaging/out-mac/Remote Whisper.app" /tmp/rw-smoke-data
```

uv・Node.js・git が要ります。1GB ほどダウンロードします。CI では `.github/workflows/package.yml` の `mac` のジョブ（`macos-latest`）で、ビルド・`.dmg` から写した `.app` の確認（`--mock` で `/api/health` まで）をして、`.dmg` を artifact に置きます。アイコン（`packaging/icon/remote-whisper.icns`）は `packaging/make-icon.py` でロゴから作ります。
