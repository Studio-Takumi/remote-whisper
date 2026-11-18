# デモ版

> [仕様書の目次](README.md)

デモ版は `demo` ブランチの web のビルドで、rw-demo.studio-takumi.dev に静的に置く（#412）。サーバー・relay・D1 は持たない。ベンチ 100 本（チャンネルごとのプロジェクト）の文字起こしと要約を、録音しないで見られるようにする（#413）。

## 常にデモで動く

- `demo` ブランチのビルドは、URL に関係なく常にデモ（`vite.config.ts` の `__DEMO_BUILD__`。テストでは `false`）。土台はもとの `?demo`（`web/src/api/demo.ts` の `isDemo`）で、`isDemo` を見ている操作はそのまま
- サーバーにはつながない。WebSocket を開かず、HTTP の API も投げない（つながらない表示も出ない）。API は `web/src/api/api.ts` の手前で、同梱したデータから答える（下の「API の代わり」）
- 通信の入口（`web/src/api/endpoint.ts` の `apiUrl`・`wsUrl`）は、デモ版のビルドで呼ぶと例外にする（main を取り込んで `isDemo` を見ずに通信する箇所が増えたら、コンソールのエラーで気づけるように）。直接 `fetch` や `WebSocket` を足すときも `isDemo` を見る
- 同梱するデータがない（CI など）ときは、`?demo` と同じく `mock.ts` のダミーデータで動く。ビルドとテストはデータなしで通る

## データ

- 置き場は環境変数 `RW_DEMO_DATA`（相対パスはビルドを動かすディレクトリから）。中は `home/`（`~/.remote-whisper` と同じ構成）と `replay/`（リプレイ。#416）。省いたときは、リポジトリの隣の `rw-hp-contents/demo`
- `RW_DEMO_DATA` を渡したのに `home/` がなければ、ビルドを止める（データなしで出してしまわないように）。省いて隣にもなければ、データなしでビルドする
- プロジェクト＝チャンネル（名前はチャンネル名＝`project.json` の `path` の最後）。セッション＝ベンチの動画
- ビルド時に読むのは `home/setting.json`（`projectOrder` と、表示する要約を選ぶ `ollama.models` の `overview`・`detail`）と、`home/projects/<ID>/` の `project.json`・`transcript-*.md`・`transcript-final-*.md`・`summary-*.md`・`.tmp/<ID>/live-summary.md`。録音ファイルは同梱しない
- プロジェクトの ID の形には頼らない（サーバーと同じく `[A-Za-z0-9-]+` のディレクトリで、`project.json` があるもの）。`project.json` とセッションには `uuid` が要る（ないとビルドを止める）

## md の読み方

サーバーと同じ結果にする（`web/vite/demoDocs.ts`・`web/vite/demoHome.ts`）。

| サーバー | デモ版 |
|---|---|
| `storage/documents.py` の `parse`（フロントマターは YAML 1.1、日時は文字列のまま） | `parseDoc`（`yaml` の 1.1 から timestamp を外して読む） |
| `storage/session_reader.py` の `parse_transcript_lines` | `parseTranscriptLines` |
| 読めない要約・浄書済み文字起こしは飛ばす | 同じ（ビルドのログに出す） |
| 一覧・行・フロントマターの既定値（`routes/projects.py`・`routes/sessions/read.py`） | 同じ形の JSON をビルド時に作る |

違うところ:

- `files.recording` はいつも `false`（録音を同梱しないため。再生の UI は出ない）
- 置き換え（#176）は浄書済み文字起こしに当てない。置き換えのあるセッションはビルドを止める（ベンチのデータにはない）
- プロジェクトの名前はパスの `\` と `/` のどちらでも区切る（Windows のサーバーと同じ）

確かめ方: 本物のサーバー（`create_app` と `TestClient`）に同じ `home/` を読ませ、下の GET の答えをすべて比べて一致すること（#413 の PR で 941 件）。

## API の代わり

`web/src/api/demoServer.ts` の `DemoServer` が、`GET` にだけ答える。それ以外は `403`（「デモ版では変更できません」）。

| パス | 答え |
|---|---|
| `/api/projects` | プロジェクトの一覧（`projectOrder` の順） |
| `/api/projects/{pid}/context-sets` | 参考資料セット（ベンチは空） |
| `/api/projects/{pid}/sessions` | セッションの一覧（新しいものから） |
| `/api/projects/{pid}/sessions/{sid}` | セッションの行と `transcriptMeta` |
| `.../transcript` | 文字起こし（リアルタイム。アップロードした動画は空） |
| `.../final-transcripts`、`.../final-transcripts/{gid}`（`latest` も） | 浄書済み文字起こし |
| `.../summaries`、`.../summaries/{gid}`（`latest` も） | 最終要約。`latest` は全体概要と要約詳細のモデルの組で選ぶ（サーバーと同じ） |

ないもの・ない版は、サーバーと同じステータスと文言（`404`・`410`）。ほかのパスは `404`。

## ビルドの形

- `web/vite/demoDataPlugin.ts` が `virtual:rw-demo-data` を作る。一覧（プロジェクトとセッションの行）は最初の JS に入り、セッションの中身（文字起こし・浄書・要約）はセッションごとのチャンク（`demo-session-<番号>-<ハッシュ>.js`）にして、開いたときに読む
- PWA が最初に取っておくのは今までどおり `index-*` だけで、セッションのチャンクは開いたときに取る

## 要約

- 要約は qwen3.5:4b と gemma4:e4b の両方を、要約の版として出す（版の切り替えはふだんの画面のまま）
- 既定は gemma（画面の既定の設定の全体概要・要約詳細が gemma4:e4b のため）
- 要約の先頭の出典の行（「この要約は〜から生成されています。」と URL）はデータ側に入っている。画面・パーサーは触らない

## この Issue でやらないこと

- 操作を止める・注意書き・バージョン表示・コピー対策（#414）
- 設定の画面（#415）
- リプレイ（#416）
