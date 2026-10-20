# 7. API

> [仕様書の目次](README.md)

## 7.1 REST

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/settings` | 全体設定を返す |
| PATCH | `/api/settings` | 全体設定を部分的に更新する。録音中に、録音中は変えられない項目（5.3 節）の値を変えようとすると `409` |
| GET | `/api/settings/options` | 選べる値を返す（Whisper のモデル、Ollama のモデルと、それぞれが思考モードに対応しているか。処理ごとのモデルのうち Ollama に入っていないもののキー `ollama.missing`。5.3 節） |
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
| DELETE | `/api/projects/{pid}/sessions/{sid}/terms/{term}` | 用語リストから語を外す。手で足した語は外すだけ（`rejectedTerms` には入れない）。用語リスト（文字起こし抽出）は、以後そのセッションでは足さない（`rejectedTerms` に入れる）。録音中なら録音中の用語リストからもすぐ外す。POST と同じ一覧を返す |
| POST | `/api/projects/{pid}/sessions/{sid}/corrections` | 置き換えを足す（#176。6.13 節）。本文は `{ "from": "間違った文字列", "to": "正しい語", "line": null }`。「この行だけ」は `line` に `{ "transcript": "live" \| "final", "generation": "<版 ID>", "index": <行の番号（0 から）> }`（`final` のときは `generation` が要る）。正しい語を手で足した語にも入れる。録音中なら、すでに出た行と以後に出る行に当てる。不正なら `400`。terms と同じ一覧に `corrections` を足して返す |
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

- `{pid}` には、プロジェクト ID の代わりにプロジェクトの UUID（5.2 節）も使える。プロジェクトの一覧とセッションの一覧・メタ情報には `uuid` を付ける。
- 画面の URL（`/s/<UUID>` など、8 章）にはファイルがないので、`/api`・`/ws` 以外の拡張子のないパスには `index.html` を返す（SPA のフォールバック）。拡張子のあるもの（なくなった JS など）は `404` のまま。
- 画面（web）のバージョンも同じくコミットハッシュで、ビルドしたとき（開発サーバーでは起動したとき）に埋め込む。設定画面にサーバーと画面のバージョンを並べて出し、食い違っていたら（クライアントに古い画面が残っているなど）目立たせて、読み込み直すように促す。画面はサーバーにつながるたびにバージョンを取り直す。

- セッションの一覧とメタ情報には、`files`（`recording`・`transcript` があるか、浄書済み文字起こしの版の数 `finalTranscripts`、最終要約の数 `summaries`、リアルタイム要約があるか `liveSummary`）を付ける。クライアントはこれを見て「期限切れ」を出す。
- 文字起こしのファイルが消えたセッションの `GET .../transcript` は `410`（セッション自体がなければ `404`）。文字起こしは `lines`（`[{time, text}]`）とフロントマター `meta` で返す。
- `GET .../summaries/latest` でリアルタイム要約を返すときは `kind: "live"`、最終要約は `kind: "final"` を付ける。どちらもなければ `404`。

## 7.2 WebSocket `/ws`

接続は1本で、録音とサーバーの状態の通知の両方に使う。サーバーから送るメッセージには、関係するセッション ID を付ける。

**クライアント → サーバー**

| 種類 | 中身 |
|---|---|
| 制御 | `{"type":"start","project":"<pid>"}` / `{"type":"stop"}` / `{"type":"pause"}` / `{"type":"unpause"}` / `{"type":"resume","session":"<sid>","nextSeq":n}`（`resume` は再接続のためのもので、一時停止からの再開は `unpause`） / `{"type":"continue","project":"<pid>","session":"<sid>"}`（途中で終わったセッションと、普通に終えてから `recording.continueWindowMin` 分以内のセッションの続きを録音する。6.7 節） |
| 音声 | バイナリ。先頭4バイトが連番（uint32、リトルエンディアン）、続きが 16kHz・モノラル・Int16 の PCM |

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
| `finalTranscript` | `generationId`。浄書済み文字起こしができた（6.9 節）。全員に送る |
| `status` | `whisper`（`unloaded` / `loading` / `ready` / `error`）、`ollama`（`ready` / `error`）、`recordings`（録音中のセッションの数）、`queue`（待っている・実行中のジョブの数）、`jobs`、`gpu`、`summarizing`、`transcribing` |
| `error` | `code`、`message` |

- `start`・`continue` の `project` と、`continue`・`resume` の `session` には、ID の代わりに UUID（5.2 節）も使える（#177）。
- `resume` を受け付けたら、`started`（`resumed: true`、`offsetSec` は受け取り済みの録音の長さ）と、受け取り済みの最後の連番の `ack` を返す。クライアントはその次から送り直す。再開できるセッションがなければ `error`（`session_not_found`）。
- 音声の連番は 0 から始める。抜けがあったチャンクは受け取らず、受け取り済みの最後の連番の `ack` を返す。受け取り済みの連番がもう一度届いたら、捨てて `ack` だけ返す。
- `error` の `code`: `bad_message`（読めないメッセージ）、`not_recording`、`already_recording`（1つの接続で録音できるのは1つだけ）、`too_many_recordings`（`recording.maxConcurrent` を超えた）、`session_not_found`、`cannot_continue`（`continue` で、続けられるセッションではない（録音中・普通に終えてから `recording.continueWindowMin` 分を過ぎた・音声ファイルから作った）・録音ファイルが残っていない・前の録音を読み込めない）、`project_not_found`（`start` のプロジェクトが登録されていない）、`write_failed`（ディスクが一杯などで音声を保存できない。そのチャンクは受け取らずに、受け取り済みの最後の連番の `ack` を返す。最終要約を保存できなかったときにも使う）、`ollama_unavailable`、`summary_skipped`（文字起こしが空か読み込めないので、最終要約を作らなかった）、`summary_failed`（最終要約を作る途中で思わぬエラーになった。失敗として記録する）、`final_transcript_failed`（頼まれた浄書済み文字起こしの再生成ができなかった。#124）、`not_available`（録音を受け付けられないサーバー）。
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

- 認証。サーバーは localhost か Tailscale のネットワークの中だけで公開する。Tailscale は自分の端末しか入れないので、当面はこれを認証の代わりにする。外部に公開する場合は、トークン認証と WebSocket の `Origin` の確認を追加する。
- HTTPS。`getUserMedia` は安全なコンテキストでしか使えないので、実際に使うときは `tailscale serve` などで HTTPS にする。
