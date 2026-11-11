# 9. 実装メモ

> [仕様書の目次](README.md)

## 9.1 録音ファイル

- 録音中は `.tmp/<ID>/audio.wav` に追記していく。サーバーが落ちても、そこまでの音声は残る。
- 録音が終わったら mp3（モノラル・64kbps、90分で約43MB）に変換して、WAV を消す。変換には faster-whisper が内部で使っている PyAV を使う。PyAV の配布版（18.1.0 で確認）には mp3 のエンコーダー（libmp3lame）が含まれている（#36）。含まれていない配布版では m4a（AAC）にする。

## 9.2 Whisper の設定

- 既定のモデルは large-v3-turbo（実験で、精度と速さのバランスがいちばんよかった）。
- チャンクの頭で前の確定文を `initial_prompt` として渡すかどうかは、用語リストとトークンの上限を分け合うことになるので、実験してから決める。

## 9.3 Ollama

- 思考モードに対応しているかは、`ollama show` の `capabilities` に `thinking` が含まれるかで判定する。`gemma4:e4b`・`gemma4:e2b` は `thinking` を含み、`think: false` で思考なし、`true` で思考ありになる（Ollama 0.40 で確かめた。#328）。
- モデルは処理ごとに選ぶ（5.3 節の `ollama.models`、#178）。録音のあとの処理は `gemma4:e4b`、録音中の処理（途中の要約・タイトル・用語の抽出）は小さい `qwen3.5:2b` をおすすめにしている（#328）。入っていなければ、入っているモデルで代わりに動かす。
- 図の読み取り（6.6 節、#271）は、画像を読めるモデル（`ollama show` の capabilities に `vision` があるもの）だけで行う。`qwen3.5`・`gemma4` は画像も読める。講演のスライド 2 本（59 ページ）を `qwen3.5:4b`（RTX 2060）で読ませたところ、図を読むと判定した 47 ページで 1 ページ平均 5.4 秒、構成図の矢印のつながりやグラフの数値まで読めた。決算資料の 6 ページでは、`gemma4:e4b` は表を Markdown の表にして数値まで正しく写した（1 ページ 10 秒ほど）。`qwen3.5:4b` は表の数値を書かなかったり、増減を取り違えたりした（#328）。思考はオフで読む。
- 思考モードと JSON Schema（`format`）は同時に使わない。`qwen3.5:4b` で両方を指定すると、思考が出力の上限まで続いて本文が空になった（#37）。JSON Schema を使う処理（タイトル・用語の抽出・範囲の判断）は思考オフで作る。

- LLM のバックエンドは差し替えられる形にしてある（#323）。要約・用語・資料の処理は `llm.LlmClient`（Protocol）だけを見る。実装は `ollama.OllamaClient` と `lmstudio.LMStudioClient`（#324）。どちらを使うかは設定の `llm.backend`（5.3 節、#325）で、`llm_switch.LlmSwitch` が振り分ける（アプリの `ctx.ollama` はこれ。名前は前のまま）。処理ごとのモデルは、使っているバックエンドの `models` から読む（`Settings.llm_models`）。失敗は `LlmUnavailable`（`OllamaUnavailable` はその子）、画像はメッセージの `image`（base64 の PNG）で渡して Ollama のクライアントが `images` に直す、モデル取得の進み具合は `PullProgress`（`status`・`digest`・`total`・`completed`）にそろえる。
- LM Studio（#324。API の形は #322 で実機を叩いて決めた）
  - 一覧と能力は `GET /api/v1/models`。`type == "llm"` だけを `key` の名前で出す。画像は `capabilities.vision`、思考の使い分けは `capabilities.reasoning.allowed_options` に `on` と `off` の両方があるとき。`off` がない（いつも思考する）モデルには思考の指定を送らず、本文が空なら失敗にする
  - `format` なしの生成は `POST /api/v1/chat`（`reasoning`・`context_length`・`store: false`）。思考の出力は捨てる。画像はそれぞれ `{type: "image", data_url}`・`image_url`
  - `format` あり・思考オフ（タイトル・用語の抽出・範囲の判断・ページの参照）は、`/api/v1/chat`（`reasoning: "off"`）にスキーマをプロンプトの最後に付けて頼む。`/api/v1/chat` は構造化出力を受け付けず、`/v1/chat/completions` の `reasoning_effort: "none"` はプロンプトによって効かない（用語の抽出で 650〜950 トークン思考し、1 分前後かかった。#322 の追記）。返事は ```` ```json ```` のコードブロックを外して読み、スキーマ（使っている `type`・`properties`・`required`・`items`・`maxItems`・`maxLength`）で確かめる。`maxLength`・`maxItems` を超えたものは切り詰める（`/v1/chat/completions` の構造化出力も上限で切った文字列を返すので、それに合わせる。作り直すと 1 分近くかかるため）。読めない・型が違う・必須のキーがないときだけ、`POST /v1/chat/completions` の `response_format: json_schema`（`reasoning_effort: "none"`）でもう一度だけ作る
  - `format` あり・思考オン（タイトルの思考オンだけ）は `POST /v1/chat/completions` の `response_format: json_schema`（`reasoning_effort` なし）
  - `context_length` は必ず `NUM_CTX` にそろえる。違う値を送ると 2 つ目のインスタンスが載り、VRAM が溢れる。`/v1/chat/completions` は `context_length` を渡せないので、呼ぶ前に `NUM_CTX` で載せる。`NUM_CTX` 以上で載っているインスタンスがあればそれを使い、小さい context で手で載せたものは下ろさない（もう 1 つ載せて、ログに書く）
  - context を超えた入力は、ストリームが `chat.start` だけで閉じる（Ollama は黙って切り詰める）。`chat.end` なしで終わったら失敗にする。この失敗と、context を超えた 500 では `status.lmstudio` を error にしない
  - 終わった理由は返らないので、本文が切れたかは出力の上限を送ったときだけ `total_output_tokens` と比べる
  - **VRAM の扱い（#326）**: LM Studio には `keep_alive` がないので、Ollama の `keep_alive` の動き（6.3 節）を `POST /api/v1/models/load`・`unload` とサーバーの中のタイマーで作る
    - **下ろすのは remote-whisper が載せたインスタンスだけ**（載せたときの `instance_id` を覚えておく）。LM Studio は画面で手でモデルを載せて使うことが多いので、それには触らない。手で載せたものが VRAM を使っていそうなときはログに書くだけにする（録音中に別のインスタンスがあるとき・最終の文字起こしの前に残っているとき）
    - 生成の前に `NUM_CTX` で載せる（JIT 読み込みに任せない）。載せた `instance_id` を確実に覚えるため。手で下ろされた直後などで `/api/v1/chat` が読み込んだ（`model_load.*` が来た）ときも、そのインスタンスを覚える
    - 録音中は 1 つだけ（#178）。生成の前に、remote-whisper が載せたほかのインスタンスを下ろしてから載せる
    - 最終の文字起こしの前（#121）は remote-whisper が載せたものを全部下ろす
    - `keepAliveMin`（`ollama.keepAliveMin` を共通で使う）: 録音していないときは、最後の生成（か録音の終わり）から `keepAliveMin` 分たったら、remote-whisper が載せたものを下ろす。録音中・生成の途中は下ろさない。`0` なら生成が終わったらすぐ下ろす
    - remote-whisper を止めるときは、remote-whisper が載せたものを下ろす（止めたあとはタイマーが動かず、LM Studio を閉じるまで VRAM に残り続けるため）。つながらなければそのまま止まる
    - 一覧（`GET /api/v1/models`）は 3 秒だけ覚え、生成 1 回で何度も取らない（代わりのモデル選びと、載っているかの確認）。remote-whisper が載せ下ろししたものは、覚えている一覧にも反映する。設定の画面に出す一覧は、いつも取り直す
    - 選ぶ・載せる・下ろすは 1 つずつ（ロック）にする。同時に載せて 2 つ載らないように、また下ろしている最中のインスタンスを生成に使わないように
    - 使う LLM を切り替えたとき（`llm_switch.LlmSwitch`）、前のバックエンドのモデルを下ろしている途中にすぐ戻したら、次のモデルからは下ろさない（`unload_all` の `cancelled`）。下ろしている最中の 1 つは止められないので、戻したほうの生成は、それが終わるのを待ってから始める（載せ直す）

## 9.4 開発の順番（案）

1. ストアと設定（`setting.json`、`project.json`、フロントマター）
2. モックサーバー（GPU なしでも、`/ws` からダミーの partial・final・要約を流す）。GPU のない環境でフロントエンドを開発するため
3. 録音マネージャと Whisper ワーカー（partial と final）
4. リアルタイム要約・最終要約・タイトル
5. 参考資料の作成
6. 保存期間の管理と、障害からの復旧
