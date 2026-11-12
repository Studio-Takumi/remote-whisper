# 7. API

> [仕様書の目次](README.md)

## 7.1 REST

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/settings` | 全体設定を返す。LM Studio の API トークン（`lmstudio.token`）は返さず、設定済みかどうか（`lmstudio.tokenSet`）だけを返す（#325。5.3 節） |
| PATCH | `/api/settings` | 全体設定を部分的に更新する。録音中に、録音中は変えられない項目（5.3 節）の値を変えようとすると `409`。クラウド版（トンネル）から接続先など（`cloud.relayUrl`・`cloud.cloudflaredPath`・`materials.roots`・`materials.extensions`・`ollama.host`・`llm.backend`・`lmstudio.host`・`lmstudio.token`・`network.allowedHosts`）の値を変えようとすると `403`。`lmstudio.token` は、送らない・空なら保存済みのまま、`null` なら消す。返事は GET と同じ形（トークンは返さない）。`llm.backend` を変えたら、録音がすべて終わってから切り替える（5.3 節） |
| GET | `/api/settings/options` | 選べる値を返す（Whisper のモデル、使っている LLM（`llm.backend`。#325）のモデルと、それぞれが思考モードに対応しているか。5.3 節）。LLM は `llm: {backend, models, missing}`（`missing` は処理ごとのモデルのうち、そのバックエンドに入っていないもののキー。`lmstudio` なら `lmstudio.models` で見る）。#325 で足した同じ中身の古い名前の `ollama: {models, missing}` は、画面が `llm` を読むようにしたので #327 でなくした。録音中に `llm.backend` を変えたときは、切り替わるまで前のバックエンドのもの |
| GET | `/api/projects` | プロジェクトの一覧。全体設定の `projectOrder` の順（5.3 節。ないものは先頭） |
| POST | `/api/projects` | ディレクトリをプロジェクトとして登録する（すでにあればそれを返す） |
| GET | `/api/sessions/{uuid}` | セッションの UUID から、セッションのメタ情報と `projectId`・`projectUuid` を返す（#177）。なければ `404` |
| GET | `/api/projects/{pid}/sessions` | セッションの一覧（サイドバー用） |
| POST | `/api/projects/{pid}/sessions/upload` | 音声ファイルから新しいセッションを作る（6.11 節、#180）。クエリは `name`・`lastModified`、本文はファイルそのもの。`202` で作ったセッションを返す |
| GET | `/api/projects/{pid}/sessions/{sid}` | セッションのメタ情報 |
| POST | `/api/projects/{pid}/sessions/{sid}/move` | セッションを別のプロジェクトへ移す（#172。5.4 節）。本文は `{ "to": "<移動先のプロジェクト ID か UUID>" }`。移せなければ `409`（理由を `detail` に）、同じプロジェクトなら `400`、途中で失敗したら元に戻して `500`。移したセッションのメタ情報と `projectId`（移動先）を返す |
| GET | `/api/projects/{pid}/sessions/{sid}/transcript` | 文字起こし |
| GET | `/api/projects/{pid}/sessions/{sid}/final-transcripts` | 浄書済み文字起こしの版の一覧（フロントマター。古いものから） |
| GET | `/api/projects/{pid}/sessions/{sid}/final-transcripts/{gid}` | 指定した版の浄書済み文字起こし（`lines` と `meta`）。置き換え（6.13 節）を当てて返す（版のファイルは書き換えない）。`gid` に `latest` を指定すると、いちばん新しいもの。なければ `410` |
| POST | `/api/projects/{pid}/sessions/{sid}/final-transcripts` | 浄書済み文字起こしを今の全体設定（`whisper.model`・`whisper.diarize`）で再生成する（#124）。202 で使うモデルと話者分けのオン・オフを返す。結果は WebSocket で全員に送る（`finalTranscript`、作れなければ `error` の `final_transcript_failed`）。録音中・録音を終えた直後のセッションは 409、録音ファイルが消えていれば 410、WhisperX のないサーバーは 503 |
| POST | `/api/projects/{pid}/sessions/{sid}/terms` | 用語リストに手で語を足す（#175）。本文は `{ "term": "..." }`。そのセッションだけに持つ（`manualTerms`）。録音中なら録音中の用語リストにすぐ入れる。前に消した語なら `rejectedTerms` から消す。語が不正なら `400`、手で足した語が上限を超えるなら `409`。用語リスト（文字起こし抽出）・消された語・手で足した語の一覧（`pickedTerms`・`rejectedTerms`・`manualTerms`）を返す |
| DELETE | `/api/projects/{pid}/sessions/{sid}/terms?term=<語>` | 用語リストから語を外す。手で足した語は外すだけ（`rejectedTerms` には入れない）。用語リスト（文字起こし抽出）は、以後そのセッションでは足さない（`rejectedTerms` に入れる）。録音中なら録音中の用語リストからもすぐ外す。POST と同じ一覧を返す。語はクエリで渡す（パスに入れると「\」「..」「%」を含む語がクラウド版の中継で弾かれるため。#219） |
| DELETE | `/api/projects/{pid}/sessions/{sid}/terms/{term}` | 上と同じ（古い形。語をパスに入れる。「/」を含む語は外せない） |
| POST | `/api/projects/{pid}/sessions/{sid}/corrections` | 置き換えを足す（#176。6.13 節）。本文は `{ "from": "間違った文字列", "to": "正しい語", "line": null }`。「この行だけ」は `line` に `{ "transcript": "live" \| "final", "generation": "<浄書済み文字起こしの版 ID>", "index": <行の番号（0 から）> }`（`final` のときは `generation` が要る）。正しい語を手で足した語にも入れる。録音中なら、すでに出た行と以後に出る行に当てる。不正なら `400`。terms と同じ一覧に `corrections` を足して返す |
| DELETE | `/api/projects/{pid}/sessions/{sid}/corrections?from=...&to=...` | 置き換えを外す（同じ組のものはすべて）。以後は当てない。POST と同じ一覧を返す |
| GET | `/api/projects/{pid}/sessions/{sid}/recording` | 録音ファイル（mp3）。Range リクエストに対応する（好きな位置から再生できるように）。ファイルがない（保存期間を過ぎた・録音中・mp3 への変換前）ときは `404` |
| GET | `/api/projects/{pid}/sessions/{sid}/summaries` | 最終要約の一覧（版 ID・モデル・生成日時） |
| GET | `/api/projects/{pid}/sessions/{sid}/summaries/{gid}` | 指定した最終要約。`gid` に `latest` を指定すると、いちばん新しいものを返す。最終要約がまだないときは、リアルタイム要約を返す |
| POST | `/api/projects/{pid}/sessions/{sid}/summaries` | 最終要約を再生成する（202 で使うモデルを返す。結果は WebSocket で全員に送る。録音中のセッションは 409、文字起こしが消えていれば 410） |
| GET | `/api/fs?path=…` | 許可したルートの中のディレクトリの中身を返す |
| GET | `/api/projects/{pid}/context-sets` | 参考資料の一覧 |
| POST | `/api/projects/{pid}/context-sets` | 参考資料ファイルを指定して、参考資料の作成を始める |
| PATCH | `/api/projects/{pid}/selection` | 使う参考資料と、用語リスト・コンテキストそれぞれを使うかどうか、録音中に用語を拾うか（`pickTerms`）を設定する。録音中は `409` |
| GET | `/api/version` | サーバーのバージョン（`{"version": "2b23d9b"}`。5.5 節の `appVersion` と同じ値） |
| GET | `/api/push/key` | 最終要約の通知（#245。6.14 節）の VAPID の公開鍵（`{"publicKey": "<base64url>"}`）。秘密鍵は返さない |
| POST | `/api/push/subscriptions` | 通知の購読を足す。本文はブラウザの `PushSubscription.toJSON()`（`endpoint`・`keys.p256dh`・`keys.auth`）。同じ `endpoint` は置き換える。push サービスの URL でない・鍵が読めなければ `422` |
| DELETE | `/api/push/subscriptions?endpoint=…` | 通知の購読を消す（その端末の設定をオフにした）。なければ何もしない |
| GET | `/api/setup` | 初回のセットアップの案内（#291。6.15 節）。足りないものと、取っている・入れている途中の進み具合（下の「セットアップの状態」）。トンネル（クラウド版）からも見られる |
| POST | `/api/setup/llm/pull` | 使っている LLM（`llm.backend`）のモデルを取ってくる（Ollama は `/api/pull`、LM Studio は `/api/v1/models/download`。#327 で `/api/setup/ollama/pull` から変えた）。本文は `{"models": ["gemma4:e4b", …]}`（順に取る。LM Studio なら `google/gemma-4-e4b` などのカタログの ID）。取ってよいのは、そのバックエンドのおすすめのモデルだけ（ほかは `400`。6.15 節）。録音中は `409`（「録音が終わってから」）、取っている途中なら `409`、LLM のないサーバー（モック）は `409`・`503`。`202` でセットアップの状態を返す |
| DELETE | `/api/setup/llm/pull` | モデルを取るのをやめる。LM Studio には取得を止める API がないので、見に行くのをやめるだけで、LM Studio は取り続ける（`llm.pullCancellable` が `false`）。セットアップの状態を返す |
| POST | `/api/setup/whisperx` | WhisperX を同梱の Python に入れる（配布版だけ。開発の環境・もう入っている・入れている途中・録音中は `409`）。`202` でセットアップの状態を返す |
| DELETE | `/api/setup/whisperx` | 入れるのをやめて、元に戻す（戻すのは後ろで。進み具合は `GET /api/setup`）。戻している途中はやめられない |
| PUT | `/api/setup/hf-token` | HuggingFace のトークンを保存する。本文は `{"token": "hf_…"}`。形が違えば `422`（送った本文は返さない）。セットアップの状態を返す（**トークンそのものは返さない**） |
| DELETE | `/api/setup/hf-token` | 保存したトークンを消す。セットアップの状態を返す |

- `{pid}` には、プロジェクト ID の代わりにプロジェクトの UUID（5.2 節）も使える。プロジェクトの一覧とセッションの一覧・メタ情報には `uuid` を付ける。
- 画面の URL（`/s/<UUID>` など、8 章）にはファイルがないので、`/api`・`/ws` 以外の拡張子のないパスには `index.html` を返す（SPA のフォールバック）。拡張子のあるもの（なくなった JS など）は `404` のまま。
- 画面（web）のバージョンも同じくコミットハッシュで、ビルドしたとき（開発サーバーでは起動したとき）に埋め込む。設定画面に「ホスト <版> ・ クライアント <版>」と並べて出し、食い違っていたら（クライアントに古い画面が残っているなど）目立たせて、読み込み直すように促す。画面はサーバーにつながるたびにバージョンを取り直す。

- セッションの一覧とメタ情報には、`files`（`recording`・`transcript` があるか、浄書済み文字起こしの版の数 `finalTranscripts`、最終要約の数 `summaries`、リアルタイム要約があるか `liveSummary`）を付ける。クライアントはこれを見て「期限切れ」を出す。
- 文字起こしのファイルが消えたセッションの `GET .../transcript` は `410`（セッション自体がなければ `404`）。文字起こしは `lines`（`[{time, text}]`）とフロントマター `meta` で返す。
- `GET .../summaries/latest` でリアルタイム要約を返すときは `kind: "live"`、最終要約は `kind: "final"` を付ける。どちらもなければ `404`。
- **セットアップの状態（#291）**: `GET /api/setup` などが返すもの。
  - `runtime`: どの形で動いているか。`windows-bundle`（Windows の配布版）・`mac-bundle`（Mac の配布版。#292）・`dev`（開発の環境。uv）
  - `remote`: トンネル（クラウド版）から来たリクエストか。`true` なら画面はボタンを押せなくする
  - `recording`: 録音中か
  - `gpu`: `nvidia`（NVIDIA の GPU とドライバがある）・`mac`（Apple Silicon で mlx-whisper がある）・`none`（どちらもない。CPU で動く。#274）
  - `llm`（#327 で `ollama` から変えた）: 使っている LLM（`llm.backend`。録音中に変えたときは、切り替わるまで前のもの）について。`backend`（`ollama` / `lmstudio`）、`running`（つながる）、`found`（この PC に入っていそうか。動いていないときに「起動して」と「入れて」を出し分ける）、`unauthorized`（LM Studio が動いているが、トークンが違う・ない。`401`・`403` が返った）、`downloadUrl`（公式のダウンロードのページ）、`models`（そのバックエンドのおすすめのモデル。`name`・`sizeGb`（分からなければ `null`）・`installed`）、`pull`（取っている・取り終えたもの。なければ `null`。そのバックエンドのものだけ。`state`（`running` / `done` / `failed` / `cancelled`）・`backend`・`models`・`model`（取っているもの）・`index`・`completed`・`total`（バイト）・`error`）、`pullCancellable`（やめると取っている先も止まるか。LM Studio は `false`）
  - `whisperx`: `installed`、`installable`（画面のボタンで入れられるか。同梱の Python と固定した依存の一覧の両方がある配布版だけ `true`）、`downloadGb`・`diskGb`・`minutes`（大きさと時間の目安）、`command`（開発の環境で入れるコマンド。ほかは `null`）、`install`（入れている・入れ終えたもの。なければ `null`。`state`（`running` / `done` / `failed` / `cancelled`）・`phase`（`preparing` / `downloading` / `installing` / `rollingBack`）・`package`（取っているパッケージ）・`collected`・`rolledBack`・`rollbackFailed`・`elapsedSec`）
  - `hfToken`: `source`（最終の文字起こしが使うトークンの出どころ。`env`（環境変数 `HF_TOKEN`）・`file`（画面から保存したもの）・`login`（`hf auth login` で保存したもの）・`null`（ない））。**トークンそのものはどの API も返さない**
- **トンネル（クラウド版）から断るもの（#291）**: `/api/setup` の `GET` 以外（トークンの保存・消す、WhisperX を入れる・やめる、モデルを取る・やめる）は、トンネル（8001 番。`via_tunnel`）から来たら `403`。クラウドのログインを盗まれても、ホストに数 GB を落とさせたり、話者分けに使うトークンを差し替えさせたりしないように。セルフホスト版（8000 番）は Host・Origin の確認（7.5 節）の下で受け付ける

## 7.2 WebSocket `/ws`

接続は1本で、録音とサーバーの状態の通知の両方に使う。サーバーから送るメッセージには、関係するセッション ID を付ける。

**クライアント → サーバー**

| 種類 | 中身 |
|---|---|
| 制御 | `{"type":"start","project":"<pid>"}` / `{"type":"stop"}` / `{"type":"pause"}` / `{"type":"unpause"}` / `{"type":"resume","session":"<sid>","nextSeq":n}`（`resume` は再接続のためのもので、一時停止からの再開は `unpause`） / `{"type":"continue","project":"<pid>","session":"<sid>"}`（途中で終わったセッションと、普通に終えてから `recording.continueWindowMin` 分以内のセッションの続きを録音する。6.7 節） |
| 音声 | バイナリ。先頭4バイトが連番（uint32、リトルエンディアン）、続きが 16kHz・モノラル・Int16 の PCM |
| 見る（#238） | `{"type":"watch","session":"<sid か UUID>"}` / `{"type":"unwatch"}`。ほかのクライアントで録音中のセッションを見る・見るのをやめる（下の「録音中のセッションを見る」） |

**サーバー → クライアント**

| type | 中身 |
|---|---|
| `started` | `session`。`start` のときは `sessionUuid`（新しいセッションの UUID。画面はこの URL に置き換える）。`resume` のときは `resumed: true` と `offsetSec`（受け取り済みの録音の長さ）、`continue` のときは `continued: true` と `offsetSec`（前の録音の長さ。時刻はここから続く） |
| `ack` | `seq`。クライアントは、ここまでの音声を手元のバッファから消してよい |
| `partial` | `segment`、`committed`、`tentative` |
| `final` | `segment`、`start`、`end`、`text`。`text` が空なら、そのチャンクは文字にならなかった（話していないのに出た文をすべて捨てた・Whisper を使えなかった）。クライアントは partial を消すだけで、行は足さない |
| `transcriptionStalled` | `stalled`（音は届いているのに文字起こしが出ていない。また出るようになったら `false`。6.2 節）。`resume` したときは、今の状態（止まっていなければ `false`）を送り直す（切れている間の知らせは届かないため） |
| `summary.delta` | `kind`（`live` / `final`）、`text`（追加分）。`replace: true` のときは、追加分ではなく、届いている下書きをこの `text` で置き換える（リアルタイム要約の前置きと、できあがった全体。6.4 節） |
| `summary.done` | `kind` |
| `title` | `title`、`provisional`（仮のタイトルかどうか） |
| `terms` | `terms`（録音中に拾って用語リストに足した語）、`rejected`（消された語）、`manual`（手で足した語）。用語リスト（文字起こし抽出）・手で足した語が変わったときに送る |
| `corrections` | 置き換え（6.13 節）を足した・外した（全員に送る）。画面はそのセッションの文字起こしを取り直す |
| `projectOrder` | プロジェクトの並び順（`projectOrder`、5.3 節）が変わった（#173。全員に送る）。画面は設定を取り直して一覧を並べ直す（知らないプロジェクトがあれば一覧ごと取り直す） |
| `sessionMoved` | セッションを別のプロジェクトへ移した（#172。全員に送る）。`session`・`sessionUuid`・`from`・`to`（プロジェクト ID）。画面は一覧を取り直し、開いていたら移した先で開いたままにする |
| `contextSet` | `project`（プロジェクト ID）、`id`、`status`（`generating` / `ready` / `failed`） |
| `watching` | `watch` の返事（#238）。`state`（`recording` / `paused` / `disconnected` / `idle`）。`idle` は録音中ではない（自分で録音しているセッションも `idle`）ので見ない。そうでなければ、そこまでの `transcript`（`[{time, text}]`）・`liveSummary`・`title` が付く |
| `recordingState` | 見ているセッションの録音の状態が変わった（#238）。`state`（`recording` / `paused` / `disconnected` / `stopped`）。見ているクライアントにだけ送る |
| `finalTranscript` | `generationId`。浄書済み文字起こしができた（6.9 節）。全員に送る |
| `status` | `whisper`（`unloaded` / `loading` / `ready` / `error`）、`ollama`（`ready` / `error`）、`lmstudio`（`ready` / `error`。LM Studio を一度も呼んでいなければ項目ごと出さない。#324）、`recordings`（録音中のセッションの数）、`queue`（待っている・実行中のジョブの数）、`jobs`、`gpu`、`summarizing`、`transcribing` |
| `error` | `code`、`message` |

- `start`・`continue` の `project` と、`continue`・`resume` の `session` には、ID の代わりに UUID（5.2 節）も使える（#177）。
- `resume` を受け付けたら、`started`（`resumed: true`、`offsetSec` は受け取り済みの録音の長さ）と、受け取り済みの最後の連番の `ack` を返す。クライアントはその次から送り直す。再開できるセッションがなければ `error`（`session_not_found`）。
- 音声の連番は 0 から始める。抜けがあったチャンクは受け取らず、受け取り済みの最後の連番の `ack` を返す。受け取り済みの連番がもう一度届いたら、捨てて `ack` だけ返す。
- `error` の `code`: `bad_message`（読めないメッセージ）、`not_recording`、`already_recording`（1つの接続で録音できるのは1つだけ）、`too_many_recordings`（`recording.maxConcurrent` を超えた）、`session_not_found`、`cannot_continue`（`continue` で、続けられるセッションではない（録音中・普通に終えてから `recording.continueWindowMin` 分を過ぎた・音声ファイルから作った）・録音ファイルが残っていない・前の録音を読み込めない）、`project_not_found`（`start` のプロジェクトが登録されていない）、`write_failed`（ディスクが一杯などで音声を保存できない。そのチャンクは受け取らずに、受け取り済みの最後の連番の `ack` を返す。最終要約を保存できなかったときにも使う）、`ollama_unavailable`、`summary_skipped`（文字起こしが空か読み込めないので、最終要約を作らなかった）、`summary_failed`（最終要約を作る途中で思わぬエラーになった。失敗として記録する）、`final_transcript_failed`（頼まれた浄書済み文字起こしの再生成ができなかった。#124）、`not_available`（録音を受け付けられないサーバー）。
- **録音中のセッションを見る（#238）**: 録音しているクライアントでなくても、同じホストにつないでいるクライアント（クラウド版では同じアカウントのクライアント。10 章）は、録音中のセッションのリアルタイム文字起こし・リアルタイム要約を見られる。
  - クライアントは、開いたセッションが録音中（一覧の `status` が `recording`）で、自分で録音していなければ `watch` を送る。ほかのセッションを開いた・録音が終わったら `unwatch` を送る。1 つの接続が見るのは 1 つだけ（`watch` し直すと前のものはやめる）。サーバーは見ていることを接続ごとに覚えるだけなので、つながり直したら送り直す。
  - サーバーは、見始めたときにそこまでの文字起こし・リアルタイム要約・タイトルを `watching` で送り、そのあとは録音しているクライアントに送るセッションのメッセージ（`partial`・`final`・`summary.delta`／`summary.done`（`live`）・`title`・`terms` など）を、見ているクライアントにも送る。`ack`・`started`・`error` は録音しているクライアントにだけ送る（`error` は録音の操作・音声の書き込みの失敗で、見る側には関係がなく、チャンクごとに出るものもあるため）。`watching` は登録してから待たずに送るので、そのあとのメッセージより先に届く。見ている側への送信は、録音している側に送ったあとにまとめて行う（遅い接続が 1 つあっても、ほかを待たせない）。
  - 録音の状態が変わったら（一時停止・再開・録音しているクライアントとの接続が切れた・つなぎ直した・続きから録音した）、見ているクライアントに `recordingState` を送る。録音を終えた・中断した（つなぎ直すのを待つ時間が過ぎた）ときは、話している途中だった最後の区間の `final` を送り終えてから `stopped` を送り、見ている登録を消す。最終の文字起こし・最終要約は全員に送るもの（`status` の `transcribing`・`summarizing`、`finalTranscript`・`title`）で気づける。
  - **見る側は読むだけ**。録音の操作（`pause`・`stop` など）と音声は、そのセッションを録音している接続からしか受け付けない（ほかの接続からは `not_recording`）。
- サーバーとの接続（再接続中かどうか）とマイクの許可は、`status` には含めず、クライアント側で判定して表示する。
- `recordings` と `queue` は、今のところ クライアントには出さない。
- `jobs` は GPU キュー（6.3 節）の `running`（実行中のジョブ。`kind`・`session`・`runningSec`、なければ `null`）と `waiting`（待っているジョブを実行する順に。`kind`・`session`・`count`・`waitingSec`）。続けて並ぶ同じ種類・同じセッションのジョブは1つにまとめて `count` にする（partial が溜まっても長くならないように）。秒数は送った時点のもので、クライアントは受け取ってからの時間を足して出す。ジョブが変わるたびに送るが、0.5 秒の間の変化はまとめて送る（partial のたびに送りすぎないように）。
- `gpu` は GPU の使用率と VRAM（`util`（%）・`memUsedMb`・`memTotalMb`）。`nvidia-ml-py` で3秒おきに取る。NVIDIA の GPU やドライバがない環境とモックでは `null`（サーバーはそのまま動く）。
- `transcribing` は、浄書済み文字起こし（6.9 節）を作っているセッションの ID の一覧。録音が終わるのを待っている間（GPU キューに積む前）も入る。画面は「作成中」を出すのに使う（#124）。
- `summarizing` は、最終要約を作っているセッションの ID の一覧。録音を終えてから（残りの文字起こし・変換のあいだも含めて）最終要約のジョブが終わるまでと、再生成のジョブが終わるまで入る。録音を終えたときは、`recordings` が減ったことを知らせる `status` にすでに入っている。最終要約の結果（`title`・`error`）は一度しか送らないので、接続が切れていて取りこぼしたクライアントは、`summarizing` から外れたこと（つながり直した直後の `status` に入っていないこと）で作り終えたと判断し、保存されたものを取り直して「作成中」を消す（#118）。

## 7.3 ディレクトリ一覧 API の安全対策

- 返すのは `materials.roots` に指定したディレクトリの中だけにする。パスは、`..`、シンボリックリンク、ジャンクションをすべて解決した実際のパスで判定する。
- 中身を読み込むファイルは、`materials.extensions` に指定した拡張子のものに限る。
- 一覧には、ルートの外を指すリンクと、`.` で始まる隠しファイルを出さない。`path` を省略すると、ルートの一覧を返す。
- プロジェクトとして登録できるのも、ルートの中のディレクトリだけにする。

## 7.4 検討事項（今回は実装しない）

- 認証。サーバーは localhost か Tailscale のネットワークの中だけで公開する。Tailscale は自分の端末しか入れないので、当面はこれを認証の代わりにする。外部に公開する場合は、トークン認証を追加する（Host・Origin の確認は 7.5 節で入れた）。
- HTTPS。`getUserMedia` は安全なコンテキストでしか使えないので、実際に使うときは `tailscale serve` などで HTTPS にする。

## 7.5 Host・Origin の確認（#249）

8000 番は、すべてのリクエスト（API・WebSocket・画面の静的ファイル）の `Host` と `Origin` を確かめ、許していないものは断る（`server/src/remote_whisper/host_check.py`）。ホストの PC や同じ LAN の端末のブラウザで、ほかのサイトを開いているときに、そのサイトから 8000 番を使われないようにするため。

- **防ぐもの**
  - クロスサイトの WebSocket の乗っ取り（CSWSH）: ほかのサイトの画面が `ws://127.0.0.1:8000/ws` につないで録音・文字起こしを読む。ブラウザは WebSocket に同一オリジンの制限をかけないので、`Origin` で断る
  - DNS rebinding: 攻撃する人の名前（`evil.example`）を、あとからこの PC のアドレスに向け直して、API（設定の書き換え・文字起こしの読み出し）を同じオリジンとして読む。このときブラウザは `Host: evil.example` を送るので、`Host` で断る
- **許す Host**（ポートは見ない。大文字小文字・末尾の `.` は無視）
  - IP アドレス（`127.0.0.1`・`::1`・LAN の IP・Tailscale の IP など、どれでも）。IP アドレスで開いた画面はそのアドレスのオリジンになるので、向け直しには使えない。DHCP でアドレスが変わっても、つなぎ直さずに使えるように、この PC のアドレスかどうかは見ない
  - `localhost`
  - `*.ts.net`（`tailscale serve`。名前は Tailscale の DNS が決めるので、攻撃する人は向け直せない）
  - この PC の名前（OS のホスト名・その最初のラベル・`<最初のラベル>.local`）。mDNS や Tailscale の MagicDNS の短い名前で開いている人のため
  - 起動したときの `--host` の名前（トレイの「ブラウザで開く」はこの名前で開く）
  - 全体設定の `network.allowedHosts`（5.3 節）。HTTPS の中継（Caddy・nginx など）の名前を足す
  - `Host` がないリクエスト（HTTP/1.0 など。ブラウザは必ず送る）
- **許す Origin**
  - `Origin` がない（ブラウザ以外。ブラウザの同じオリジンの GET）
  - `Host` と同じオリジン（ホスト名とポート。ポートを書いていなければ `Origin` の scheme の既定のポート。`tailscale serve` は `Host` に `x.ts.net`、`Origin` に `https://x.ts.net` が来る）。scheme は見ない（HTTPS の中継の後ろでは、サーバーには http で届くため）
  - `network.allowedHosts` の名前のオリジン（`Host` を書き換える中継の後ろに置いたとき。nginx の既定は `Host` を転送先の `127.0.0.1:8000` にする）。**このときはポートを見ない**ので、IP アドレスを足すと、その IP のどのポートの画面からでも通る（足すのは中継の名前だけにする）
  - `null`・`http`/`https` 以外（拡張機能など）は断る
- **Vite の開発サーバー**: `/api`・`/ws` の転送は `Host` を書き換えない（`changeOrigin` を付けない）。`Host` も `Origin` も開発サーバーのもの（`localhost:5190` など）になり、同じオリジンとして通る
- **断るとき**: HTTP は `403`（`{"detail": "..."}`）。WebSocket はつなぐ前に閉じる（ブラウザには HTTP の `403` が返る）。何もしないで断るので、設定の書き換えなどは起きない。`Host` か `Origin` が 2 つ以上あるときも、どちらを読むかで食い違わないように断る。`X-Forwarded-Host` などの転送のヘッダーは見ない。ログ（`server.log`）に、メソッド・パス・断った理由（`host not allowed`・`origin not allowed`・`duplicate host`・`duplicate origin`）と `Host`・`Origin` の値を警告で書く。接続元の IP は書かない。同じ組は 60 秒に 1 回だけ書く
- **トンネル（8001 番）は見ない**: Worker の署名で守っていて（10.5 節）、`Origin` は Worker が確かめる。`RelayAuthApp` が付けた印（`via_tunnel`）があるリクエストは、そのまま通す
