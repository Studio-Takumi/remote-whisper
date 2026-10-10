# remote-whisper

**三行まとめ**

文字起こしサービスは制限あるし有料プランに誘導される！

でも、家には余ってるGPUがある！

なら家のGPUを使ってAI要約しようぜってツール

**以下AIによる解説↓**

手元の端末にGPUがなくても、別のマシンのGPUを使って疑似リアルタイムで文字起こしするためのツールです。

ブラウザでマイク音声を取り、WebSocket で GPU マシンに送ります。GPU マシンでは [faster-whisper](https://github.com/SYSTRAN/faster-whisper) が文字起こしし、その結果をブラウザに返します。ノートPCやタブレットからでも、GPU を積んだデスクトップや自宅サーバーで文字起こしできます。

```mermaid
flowchart LR
    subgraph Client["クライアント（任意の端末）"]
        Mic["getUserMedia<br/>マイク入力"] --> Worklet["AudioWorklet<br/>16kHz / Int16 PCM"]
        View["文字起こし結果を表示"]
    end
    subgraph GPU["GPU マシン"]
        WS["FastAPI + WebSocket"] --> Whisper["faster-whisper<br/>(CUDA)"]
        WS --> Ollama["Ollama<br/>要約・用語リスト"]
    end
    Worklet -- "音声（バイナリ）" --> WS
    WS -- "partial / final（JSON）" --> View
```

> 🚧 開発中です。録音・文字起こし・途中の要約・最終の要約・参考資料セット・保存期間の管理・障害からの復旧まで動きます。別の端末から使う手順は「別の端末から使う（HTTPS）」を見てください。

## 画面

録音中は、話している内容が流れるように文字起こしされ、数分おきに途中の要約が更新されます。録音が終わると、時間をかけて最終の要約を作ります。

![録音中の文字起こし](docs/images/desktop-light-recording.png)

| 要約（Markdown・数式・コード） | 録音中の途中の要約（ダーク） |
| --- | --- |
| ![要約](docs/images/desktop-light-summary.png) | ![途中の要約](docs/images/desktop-dark-recording-summary.png) |

| スマホ | 設定 | 参考資料の選択 |
| --- | --- | --- |
| ![スマホ](docs/images/mobile-light-recording.png) | ![設定](docs/images/desktop-light-settings.png) | ![参考資料](docs/images/desktop-light-materials.png) |

ほかの画面（ライト・ダーク、デスクトップ・スマホ）は [docs/images/](docs/images/) にあります。画像の中のプロジェクトや会話はすべて架空のものです。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `server/` | GPU マシンで動く文字起こしサーバー（Python / faster-whisper） |
| `web/` | ブラウザ側のフロントエンド（Vite + React + TypeScript / Tailwind CSS / shadcn/ui） |

## サーバーのセットアップ

### 必要なもの
- NVIDIA GPU と、それに対応したドライバ
- Python 3.11 と [uv](https://docs.astral.sh/uv/)
- [Ollama](https://ollama.com/)（要約と用語リストの生成に使う）

### インストール

```bash
cd server
uv sync
```

依存（faster-whisper、FastAPI など）は `server/pyproject.toml` にまとめてあります。cuBLAS と cuDNN の DLL は pip で入れた `nvidia-*` パッケージから読み込むので、CUDA Toolkit を別途インストールする必要はありません。

### 起動

```bash
uv run remote-whisper              # http://127.0.0.1:8000
uv run remote-whisper --host 0.0.0.0 --port 8000
```

- `GET /api/health` が `{"status":"ok"}` を返せば起動しています。
- データ（設定・録音・文字起こし・要約）は `~/.remote-whisper/` に置きます。環境変数 `REMOTE_WHISPER_HOME` で場所を変えられます（システムドライブの空きが少ないときは、別のドライブを指定してください）。全体設定は `setting.json` で、初回の起動時に既定値で作られます。
- `web/dist` にフロントのビルド結果があれば、同じサーバーから画面も配信します（`cd web && npm run build`）。場所は環境変数 `REMOTE_WHISPER_WEB_DIST` で変えられます。

### 動作確認（ファイルの文字起こし）

```bash
uv run python transcribe.py sample.wav
```

モデルの既定は `large-v3-turbo` です。large-v3 と同程度の精度で、2倍以上速く動きます。日本語向けのモデル [`kotoba-tech/kotoba-whisper-v2.0-faster`](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-faster) も試しましたが、turbo のほうが誤変換が少なくなりました。モデルは初回実行時にダウンロードされ、`server/hf/` に保存されます（環境変数 `HF_HOME` で場所を変えられます）。

### 開発

```bash
uv run ruff check
uv run ruff format --check
uv run pytest
```

### Ollama（要約・用語リスト）

[公式サイト](https://ollama.com/download)から GPU マシンにインストールし、モデルを取得します。

```bash
ollama pull qwen3.5:4b
```

- モデルは、思考モード（`think`）に対応したものを推奨します。録音後の要約と用語リストの生成で思考モードを使うと、精度が上がるためです。対応していないモデルを選んだ場合は、思考モードなしで動きます。
- サーバーは `http://localhost:11434` の Ollama に接続します。

## フロントエンドの開発

```bash
cd web
npm install
npm run dev
```

開発中は、Vite の dev server が `/api` と `/ws` をサーバー（既定は `http://localhost:8000`）へ転送します。転送先は環境変数 `REMOTE_WHISPER_SERVER` で変えられます。

### GPU のない環境で開発する（モックサーバー）

```bash
cd server
uv run remote-whisper --mock
uv run remote-whisper --mock --mock-live-summary-sec 10   # 途中の要約を 10 秒おきに送る
```

`--mock` を付けると、Whisper と Ollama の代わりに、架空の打ち合わせの台本からダミーの文字起こし（partial・final）と要約を `/ws` で流します。届いた音声には `ack` を返すだけで、中身は使いません。画面から登録したプロジェクトに録音すると、ダミーの文字起こしと要約はファイルとして保存され、後から開けます（録音ファイルは作りません）。途中の要約の間隔は、設定の `liveSummaryIntervalMin` ではなく `--mock-live-summary-sec` で決まります。開発用に次の API も使えます。

- `POST /api/mock/status` … `{"whisper": "error"}` や `{"ollama": "error"}` で、サーバーの状態を変えて全員に `status` を送る
- `POST /api/mock/context-set` … 参考資料セットの作成をまねて、`contextSet` を `generating` → `ready`（`{"result": "failed"}` なら `failed`）の順に送る
- `POST /api/mock/disconnect` … WebSocket をすべて切る（再接続と録音の再開を確かめる用）

### スクリーンショットを撮り直す

`docs/images/` の画像は、モックサーバーとダミーデータを使って Playwright で撮っています。画面の URL に `?demo` を付けると、サーバーのデータではなく `web/src/mock.ts` のダミーデータ（架空のプロジェクトとセッション）を出すので、スクリプトはそれで撮ります。

```bash
cd server && uv run remote-whisper --mock --mock-live-summary-sec 5   # ターミナル 1
cd web && npm run dev                                                  # ターミナル 2
cd web && npx playwright install chromium && npm run screenshots       # ターミナル 3
```

画面の URL は `SCREENSHOT_URL`（既定: `http://localhost:5173`）、手元の Chromium を使うときは `CHROMIUM_PATH` で指定できます。

## 別の端末から使う（HTTPS）

ブラウザの `getUserMedia`（マイク）は、安全なコンテキスト（HTTPS か `localhost`）でしか動きません。GPU マシン以外の端末（ノートPC・スマホ）から録音するには、画面を HTTPS で開く必要があります。画面を HTTPS で開けば、WebSocket も自動で `wss://` になります。

ここでは [Tailscale](https://tailscale.com/) の `tailscale serve` を使う手順を書きます。証明書の取得と HTTPS 化を Tailscale がやってくれ、自分の Tailscale のネットワーク（tailnet）の端末からしか見えないので、一番手軽です。

### 1. 画面をビルドして、サーバーから配信する

```bash
cd web
npm ci
npm run build          # web/dist ができる

cd ../server
uv run remote-whisper  # http://127.0.0.1:8000 で画面と API を配信する
```

`web/dist` があれば、サーバーが画面も配信します。GPU マシンのブラウザで `http://localhost:8000` を開いて、画面が出ることを確かめてください。サーバーは `127.0.0.1` のまま（`--host 0.0.0.0` にしない）で構いません。外からは次の `tailscale serve` を通して入ります。

### 2. `tailscale serve` で HTTPS にする

1. GPU マシンと、録音に使う端末の両方に Tailscale を入れて、同じ tailnet にログインします。
2. Tailscale の管理画面（DNS の設定）で、**MagicDNS** と **HTTPS Certificates** を有効にします。
3. GPU マシンで次を実行します。

   ```bash
   tailscale serve --bg 8000
   ```

   `https://<マシン名>.<tailnet 名>.ts.net/` へのアクセスを、`http://127.0.0.1:8000` に転送するようになります（WebSocket も通ります）。表示される URL を控えてください。例: `https://gpu-box.example-tailnet.ts.net/`
4. 録音に使う端末のブラウザでその URL を開き、マイクの使用を許可します。

- 今の転送の設定は `tailscale serve status` で見られます。止めるときは `tailscale serve --https=443 off`（または `tailscale serve reset`）。
- `tailscale funnel` は使わないでください。インターネット全体に公開されます。このサーバーには認証がなく、tailnet の中だけで使う前提です（spec 7.4）。

### ほかの方法

HTTPS にする方法は何でも構いません。どの方法でも、`/api` と `/ws` を同じオリジンでサーバー（`http://127.0.0.1:8000`）に転送してください。

- Cloudflare Tunnel（Cloudflare Access などで自分だけが入れるようにしてください）
- Caddy や nginx と Let's Encrypt の組み合わせ
- [mkcert](https://github.com/FiloSottile/mkcert) で作った証明書（LAN 内だけで使う場合。証明書を各端末に信頼させる必要があります）

### 開発中

フロントを手元の `localhost` で起動（`npm run dev`）すれば HTTPS は要りません。Vite が `/api` と `/ws` をサーバーに転送します（「フロントエンドの開発」を参照）。
