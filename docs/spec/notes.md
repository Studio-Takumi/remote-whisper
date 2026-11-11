# 9. 実装メモ

> [仕様書の目次](README.md)

## 9.1 録音ファイル

- 録音中は `.tmp/<ID>/audio.wav` に追記していく。サーバーが落ちても、そこまでの音声は残る。
- 録音が終わったら mp3（モノラル・64kbps、90分で約43MB）に変換して、WAV を消す。変換には faster-whisper が内部で使っている PyAV を使う。PyAV の配布版（18.1.0 で確認）には mp3 のエンコーダー（libmp3lame）が含まれている（#36）。含まれていない配布版では m4a（AAC）にする。

## 9.2 Whisper の設定

- 既定のモデルは large-v3-turbo（実験で、精度と速さのバランスがいちばんよかった）。
- チャンクの頭で前の確定文を `initial_prompt` として渡すかどうかは、用語リストとトークンの上限を分け合うことになるので、実験してから決める。

## 9.3 Ollama

- 思考モードに対応しているかは、`ollama show` の `capabilities` に `thinking` が含まれるかで判定する。
- モデルは処理ごとに選ぶ（5.3 節の `ollama.models`、#178）。軽い処理（タイトル・用語の抽出）は小さいモデル（`qwen3.5:0.8b`・`qwen3.5:2b`）をおすすめにしている（範囲の判断は、小さいモデルでは答えが安定しなかったので 4b。6.12 節）。入っていなければ、入っているモデルで代わりに動かす。
- 図の読み取り（6.6 節、#271）は、画像を読めるモデル（`ollama show` の capabilities に `vision` があるもの）だけで行う。`qwen3.5` は画像も読める。講演のスライド 2 本（59 ページ）を `qwen3.5:4b`（RTX 2060）で読ませたところ、図を読むと判定した 47 ページで 1 ページ平均 5.4 秒、構成図の矢印のつながりやグラフの数値まで読めた。思考はオフで読む。
- 思考モードと JSON Schema（`format`）は同時に使わない。`qwen3.5:4b` で両方を指定すると、思考が出力の上限まで続いて本文が空になった（#37）。JSON Schema を使う処理（タイトル・用語の抽出・範囲の判断）は思考オフで作る。

- LLM のバックエンドは差し替えられる形にしてある（#323）。要約・用語・資料の処理は `llm.LlmClient`（Protocol）だけを見る。実装は `ollama.OllamaClient` と `lmstudio.LMStudioClient`（#324。バックエンドの切り替えの設定は #325）。失敗は `LlmUnavailable`（`OllamaUnavailable` はその子）、画像はメッセージの `image`（base64 の PNG）で渡して Ollama のクライアントが `images` に直す、モデル取得の進み具合は `PullProgress`（`status`・`digest`・`total`・`completed`）にそろえる。
- LM Studio（#324。API の形は #322 で実機を叩いて決めた）
  - 一覧と能力は `GET /api/v1/models`。`type == "llm"` だけを `key` の名前で出す。画像は `capabilities.vision`、思考の使い分けは `capabilities.reasoning.allowed_options` に `on` と `off` の両方があるとき。`off` がない（いつも思考する）モデルには思考の指定を送らず、本文が空なら失敗にする
  - `format` なしの生成は `POST /api/v1/chat`（`reasoning`・`context_length`・`store: false`）。思考の出力は捨てる。`format` ありは、`/api/v1/chat` が構造化出力を受け付けないので `POST /v1/chat/completions` の `response_format: json_schema`。思考のオフは `reasoning_effort: "none"`（ほかの指定は効かなかった）。画像はそれぞれ `{type: "image", data_url}`・`image_url`
  - `context_length` は必ず `NUM_CTX` にそろえる。違う値を送ると 2 つ目のインスタンスが載り、VRAM が溢れる。`/v1/chat/completions` は `context_length` を渡せないので、呼ぶ前に `NUM_CTX` で載せる。`NUM_CTX` 以上で載っているインスタンスがあればそれを使い、小さい context で手で載せたものは下ろさない（もう 1 つ載せて、ログに書く）
  - context を超えた入力は、ストリームが `chat.start` だけで閉じる（Ollama は黙って切り詰める）。`chat.end` なしで終わったら失敗にする。この失敗と、context を超えた 500 では `status.lmstudio` を error にしない
  - 終わった理由は返らないので、本文が切れたかは出力の上限を送ったときだけ `total_output_tokens` と比べる

## 9.4 開発の順番（案）

1. ストアと設定（`setting.json`、`project.json`、フロントマター）
2. モックサーバー（GPU なしでも、`/ws` からダミーの partial・final・要約を流す）。GPU のない環境でフロントエンドを開発するため
3. 録音マネージャと Whisper ワーカー（partial と final）
4. リアルタイム要約・最終要約・タイトル
5. 参考資料の作成
6. 保存期間の管理と、障害からの復旧
