# Windows にインストールして使う

Python・uv・cloudflared を自分で入れずに、インストーラ 1 つで remote-whisper のホスト（文字起こしをする PC）を使えるようにするものです（#168）。リアルタイムの文字起こし（faster-whisper）までが入っています。録音後の最終の文字起こし（WhisperX。話者分けを含む）は入っていません（後述）。

開発の手順（`uv run remote-whisper`）は今までどおり使えます。このインストーラは、リポジトリを持っていない人向けです。

## 入っているもの

- Python 3.11（python-build-standalone）と、`server/uv.lock` の通りの依存（faster-whisper、CTranslate2、CUDA 12 の cuBLAS・cuDNN の DLL など）
- 画面（ブラウザで開くフロント）
- cloudflared（クラウド版で、ホストを外から見えるようにするトンネル。版と SHA256 を固定して公式から取ったもの）

入れる場所は `%LOCALAPPDATA%\Programs\Remote Whisper`（管理者の権限は要りません）。データ（プロジェクト・セッション・設定・ログ）は `%USERPROFILE%\.remote-whisper` にあり、**アンインストールしても消えません**。

## 手順（何も入っていない Windows で確かめる）

前提: Windows 10/11 の x64 と、NVIDIA の GPU・そのドライバ（CUDA のツールキットは要りません）。

1. **ダウンロード**: 取得元は 2 つあります。どちらも、今は匠が使う前提です。
   - **Actions の artifact**（今の主な取り方）: リポジトリの Actions →「Package」の実行 → 下の Artifacts の `remote-whisper-windows-installer` をダウンロードする。GitHub にログインしていないと取れず、**14 日で消え**、**zip に包まれて**くる（展開すると `remote-whisper-setup-<版>.exe`）。実行は「Run workflow」で出すが、このワークフローが main に入るまでは Actions の画面に出ない（それまでは、ブランチへの push で動いた実行から取る）。
   - **Release**: `v*` のタグを push すると、同じ exe が**下書き**のリリースに付く（公開されない。リポジトリに書き込める人だけが見える）。公開するときは、下書きを確かめて公開する。この場合の版（ファイル名・画面の版）はタグ名（先頭の `v` を除く）になる。それ以外はコミットの短いハッシュ。
2. **インストール**: exe を実行する。署名していないので、Windows の SmartScreen が「Windows によって PC が保護されました」と出します。「詳細情報」→「実行」で進めてください。インストール中に「Windows のログオン時に起動する」を選べます（既定はオフ）。（インストール先に、中身のある別のフォルダを選ぶと、「Remote Whisper」というサブフォルダにするか聞かれます。アンインストールは、インストーラが置いた `python`・`web` などだけを消し、選んだフォルダは空でなければ残します）
3. **起動**: インストールの最後の「今すぐ起動」か、スタートメニューの「Remote Whisper」。コンソールの窓は出ず、右下のタスクトレイにアイコンが出ます（隠れているときは `^` の中）。
4. **Cloud に登録**: トレイのアイコンを右クリック →「クラウド版にログイン」。ブラウザが開くので、ログインして、画面のコードがトレイの通知と同じかを確かめて承認する。登録できたら、トレイの「トンネル」が「つながっている」になる。
5. **録音**: ブラウザで Cloud の画面（または `http://127.0.0.1:8000/`）を開き、プロジェクトを作ってセッションで録音する。
6. **文字起こし**: 話した内容が文字起こしで出る。**初回は Whisper のモデル（large-v3-turbo。約 1.6GB）のダウンロードがあるので、出るまでに数分かかります**（ダウンロード先は HuggingFace のキャッシュ `%USERPROFILE%\.cache\huggingface`）。
7. **アンインストール**: 設定の「アプリ」から「Remote Whisper」を削除する。データのフォルダ（`.remote-whisper`）が残っていることを確かめる。

## Ollama・HuggingFace のトークンがないとき

- Ollama が入っていない（または動いていない）と、トレイのアイコンの点が橙になり、要約・用語リストの生成は「Ollama に接続できないため〜を作れませんでした」と出て作りません。**文字起こしそのものは動きます**。要約を使うときは [Ollama](https://ollama.com/) を入れてください。
- HuggingFace のトークンがないと、話者分けはしません（今までと同じ）。

## 上書きで更新するとき

新しい版のインストーラをもう一度実行すると、同じ場所に上書きします（データは残ります。起動中のサーバーは、インストーラが止めます）。「ログオン時に起動」のチェックを外して入れ直すと、自動起動の登録は消えます。

**後から入れた WhisperX は、更新のたびに依存が `uv.lock` の版に戻るので、整合が崩れることがあります。更新したら、下の WhisperX の手順をやり直してください。**

## WhisperX（最終の文字起こし・話者分け）を後から入れる

WhisperX は CUDA 版の torch で数 GB になるので、このインストーラには入れていません。後から入れる手順（設定や初回の案内から入れられるようにするのは、別の Issue で扱います）:

```powershell
$app = "$env:LOCALAPPDATA\Programs\Remote Whisper"
# uv が要ります（https://docs.astral.sh/uv/）
uv pip install --python "$app\python\python.exe" --break-system-packages --extra-index-url https://download.pytorch.org/whl/cu128 "whisperx>=3.8.6,<3.9" "torch==2.8.*" "torchaudio==2.8.*" "torchvision==0.23.*" fugashi unidic-lite
```

## 方式の選び方（Python ごと同梱 / PyInstaller）

Python ごと同梱にしました。理由:

- **ctranslate2 と CUDA の DLL**: PyInstaller はこれらを自動で集めきれず、`nvidia/cublas`・`nvidia/cudnn` の DLL の場所の指定（hook）が要り、cuDNN の DLL が多いとビルドも起動（展開）も遅くなります。サーバーは `sys.prefix\Lib\site-packages\nvidia` の下の DLL を探す作りで、普通の site-packages の形ならそのまま動きます。
- **依存を `uv.lock` のまま入れられる**: `uv export` した固定の版とハッシュで入れるので、開発の環境と食い違いません。
- **後から WhisperX などを足せる**: PyInstaller の exe には、後から pip で足せません。
- 代わりに、プロセスの名前が `pythonw.exe` になります（タスクマネージャーでは「Python」と出ます）。

## わかっている制限

- 署名していない（SmartScreen の警告が出る）。
- インストーラが大きい（CUDA のライブラリを含み、約 1.4GB）。Inno Setup の単一の exe は 2GB が上限（分割しない場合）なので、ライブラリが増えると近づく。
- WhisperX の手順の `uv pip install` は `uv.lock` で固定していないため、共通の依存（numpy など）の版が変わることがある。
- **GPU（NVIDIA）がないとき**: 文字起こしは使えません（CPU 向けの設定は用意していない）。サーバーは起動し、トレイの点が橙になり、録音しても Whisper が動かない。確かめた動作ではなく、設計上の想定です（実機で確認する項目）。
- **ポート 8000 が他で使われているとき**: サーバーは起動に失敗して終わる（ログの `%USERPROFILE%\.remote-whisper\log\server.log` に残る）。ショートカットは `--port` を付けていないので、使われているアプリを止めるか、ショートカットの引数に `--port <番号>` を足す。これも実機で確認する項目。
- Windows 10/11 の x64 だけ。
- 起動の窓口は `pythonw.exe -m remote_whisper` を指すショートカットで、専用のアイコンはまだない。
- 自動更新はない。新しい版は、インストーラをもう一度実行して上書きする。
- Mac・Linux 向けの配布は対象外。
- Ollama は同梱しない。
