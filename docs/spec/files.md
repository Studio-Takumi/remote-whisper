# 5. ファイル構成

> [仕様書の目次](README.md)

## 5.1 データのルート

既定は `~/.remote-whisper/`。環境変数 `REMOTE_WHISPER_HOME` で場所を変えられる（システムドライブの空きが少ない場合は、容量に余裕のあるドライブを指定する）。`setting.json` もルートの中に置くので、ルートの場所を `setting.json` で指定することはできない。

```
~/.remote-whisper/
├─ setting.json
├─ log/
│  ├─ server.log              # サーバーのログ（6.10 節）
│  └─ server.log.YYYY-MM-DD   # 前の日の分（10 日分）
└─ projects/
   └─ <プロジェクト ID>/
      ├─ project.json
      ├─ hotwords-<ID>.md
      ├─ context-<ID>.md
      ├─ recording-<ID>.mp3
      ├─ transcript-<ID>.md
      ├─ transcript-final-<ID>-<生成 ID>.md
      ├─ summary-<ID>-<生成 ID>.md
      └─ .tmp/
         └─ <セッション ID>/
            ├─ audio.wav
            └─ live-summary.md
```

選んだディレクトリには、最終の要約のコピーを `summary-YYYYMMDD-<タイトル>.md` という名前で置く。システムはこのコピーを読まない。同じ名前のファイルがすでにある場合は、末尾に `-2` のような番号を付ける。

## 5.2 ID と命名

| 対象 | 形式 | 例 |
|---|---|---|
| セッション ID | `YYYYMMDD-HHMMSS`（録音を開始した時刻。日付をまたいでも開始時の日付を使う） | `20261009-143012` |
| 参考資料セット ID | `YYYYMMDD-HHMMSS`（作成を開始した時刻） | `20261009-090501` |
| 要約の生成 ID | `YYYYMMDD-HHMMSS`（要約の生成を開始した時刻） | `20261009-160203` |
| プロジェクト ID | パスを変換した名前＋短いハッシュ | `D--work-meetings-a1b2c3` |
| プロジェクト・セッションの UUID | UUID（画面の URL に出す。#177） | `9ce88ddf-db8e-5f9b-818e-11c3c80f9335` |

- **UUID（#177）**: 画面の URL（8 章）に出す ID。ファイル名と今の ID・命名は変えず、`project.json`（5.4 節）にだけ持たせる。プロジェクト ID にはパスが入っていて URL に出すと読めてしまうので、プロジェクトにも持たせる。
  - 値はパスと ID から決める（UUID v5。プロジェクトはそのパス、セッションは振ったときのプロジェクトのパスとセッション ID）。`project.json` を作り直しても（5.4 節）同じ値になるようにするため。
  - 一度振ったら変えない。`project.json` に書いた値を正とし、セッションを別のプロジェクトへ移しても（#172）そのまま持っていく。そのため、移したセッションは `project.json` を作り直すと UUID が変わる。
  - #177 より前の `project.json` は、読み込んだときに振って書き足す。

- タイトル（要約から作る短い名前）はファイル名に入れない。フロントマターと `project.json` に持たせて、UI にはそれを表示する。
- プロジェクト ID の作り方: パスを絶対パスに解決し、ドライブ文字を大文字にそろえる。そのうえで英数字以外を `-` に置き換え、元のパスから作ったハッシュ（SHA-1 の先頭6文字）を末尾に付ける。
  - ハッシュを付けるのは、日本語のディレクトリ名が `-` だけになって衝突するのを防ぐため。たとえば `D:\work\会議` と `D:\work\資料` は、どちらも `D--work---` になってしまう。
  - ドライブ文字をそろえるのは、同じディレクトリが別のプロジェクトとして扱われるのを防ぐため。Windows ではパスの大文字・小文字が区別されないので、`D:\work` と `d:\work` が別々のプロジェクトとして作られてしまう。

## 5.3 setting.json

全体設定。画面右上の簡易設定と、設定モーダルの両方からこのファイルを書き換える。**録音中は、次の項目だけ変更できない**（#133。`PATCH /api/settings` で値を変えようとすると `409`。同じ値を送るのはかまわない）。ほかの項目は録音中も変えられる。

| 項目 | 録音中に変えられない理由 |
|---|---|
| `whisper.model`・`whisper.computeType` | 変えると読み込み直しになり、その間の文字起こしが止まる |
| `whisper.silenceMs`・`whisper.maxSegmentSec`・`whisper.speechThreshold`・`whisper.speechDbfs` | 区切りの設定は録音を始めたときに決まるので、今の録音には効かない |
| `recording.noiseSuppression`・`recording.autoGainControl`・`recording.echoCancellation` | ブラウザが録音を始めるときにマイクに設定する |

```json
{
  "version": 1,
  "whisper": {
    "model": "large-v3-turbo",
    "computeType": "float16",
    "beamSize": 5,
    "partialIntervalSec": 1.0,
    "silenceMs": 600,
    "maxSegmentSec": 25,
    "unloadAfterMin": 10,
    "speechThreshold": "auto",
    "speechDbfs": -40,
    "finalTranscript": true,
    "diarize": true
  },
  "ollama": {
    "host": "http://localhost:11434",
    "models": {
      "materialTerms": "qwen3.5:2b",
      "context": "qwen3.5:4b",
      "scope": "qwen3.5:4b",
      "transcriptTerms": "qwen3.5:2b",
      "liveSummary": "qwen3.5:2b",
      "liveTitle": "qwen3.5:2b",
      "overview": "qwen3.5:4b",
      "detail": "qwen3.5:4b",
      "finalTitle": "qwen3.5:0.8b"
    },
    "liveSummaryIntervalMin": 5,
    "keepAliveMin": 10,
    "liveSummaryDensity": 3,
    "overviewDensity": 3,
    "detailDensity": 3,
    "pickTerms": false
  },
  "recording": {
    "maxConcurrent": 1,
    "resumeTimeoutMin": 10,
    "continueWindowMin": 10,
    "noiseSuppression": true,
    "autoGainControl": true,
    "echoCancellation": true,
    "uploadMaxMb": 2048
  },
  "retentionDays": {
    "recording": 10,
    "transcript": 30,
    "summary": 30,
    "contextSet": 0
  },
  "materials": {
    "roots": ["D:\\work"],
    "extensions": [".md", ".txt", ".pdf", ".html"]
  },
  "display": {
    "sessionMeta": false,
    "showPickedTerms": false,
    "showSpeakers": false
  },
  "projectOrder": []
}
```

- `retentionDays` を `0` にすると無期限になる。
- `materials.roots` の既定は、サーバーを動かしているユーザーのホームディレクトリ（上の例の `D:\work` は書き換えた後の例）。
- ファイルがなければ既定値で作る。足りないキーは既定値で埋めて書き戻す。知らないキーや範囲外の値は受け付けない（`PATCH /api/settings` は `422`）。
- `recording.maxConcurrent` は、サーバー全体で同時に録音できるセッションの数。1つのクライアント（ブラウザのタブ）が同時に録音できるのは1つだけなので、2以上にするのは複数の端末から同時に録音する場合。
- `recording.resumeTimeoutMin` は、ブラウザとの接続が切れてから、つながり直すのを待つ時間（分、既定 10。0 より大きい数で、小数も書ける。設定画面からは 1 分以上）。過ぎたら `interrupted` にする（続きから録音できる。6.7 節）。
- `recording.continueWindowMin` は、普通に録音を終えた（`done`）あと、同じセッションの続きを録音できる時間（分、既定 10。0 以上。0 なら続けられない。#174）。この間は録音を WAV のまま残し、過ぎてから mp3 に変換する（6.7 節）。
- `ollama.models` は、Ollama を使う処理ごとのモデル（#178）。既定はおすすめのモデルで、軽い処理は小さいモデルにしている。おすすめはあくまで目安で、設定で自由に変えられる。

  | 大きな段階 | 処理 | キー | おすすめ（既定） |
  |---|---|---|---|
  | 参考資料 | 用語リスト（資料抽出） | `materialTerms` | `qwen3.5:2b` |
  | | コンテキスト | `context` | `qwen3.5:4b` |
  | | 範囲の判断（#182） | `scope` | `qwen3.5:4b` |
  | リアルタイム文字起こし | 用語リスト（文字起こし抽出） | `transcriptTerms` | `qwen3.5:2b` |
  | リアルタイム要約 | 要約 | `liveSummary` | `qwen3.5:2b` |
  | | タイトル | `liveTitle` | `qwen3.5:2b` |
  | 最終要約 | 全体概要 | `overview` | `qwen3.5:4b` |
  | | 要約詳細 | `detail` | `qwen3.5:4b` |
  | | タイトル | `finalTitle` | `qwen3.5:0.8b` |

  - 録音中に使う 3 つ（`transcriptTerms`・`liveSummary`・`liveTitle`）のおすすめは同じモデルにそろえている。録音中は Ollama のモデルを 1 つしか載せない（6.3 節）ので、別々だと区切りごとに読み込み直しになるため。`qwen3.5:0.8b` は、用語の抽出で語ではなく文をそのまま返すなど品質が足りなかった（#178 で比べた）。
  - **入っていないモデル**: 選んだモデルが Ollama に入っていなければ、要約詳細のモデル → 全体概要のモデル → 入っているうち名前の順で最初のもの、の順に代わりを選んで動かす（動かなくならないように）。ログに残し（モデルごとに 1 回）、`/api/settings/options` の `ollama.missing` に入っていない処理のキーを返す（画面は「入っていません」と出す。#179）。フロントマターには、実際に使ったモデルを残す。
  - **前の設定からの移行**: #178 より前の `liveSummaryModel` は `liveSummary` に、`finalSummaryModel` は `overview`・`detail` に、`contextModel` は `context`・`materialTerms` に移す。新しい軽い処理（`scope`・`transcriptTerms`・`liveTitle`・`finalTitle`）は、おすすめのモデルが入っていればそれ、なければ移行元（`scope` は `contextModel`、`transcriptTerms`・`liveTitle` は `liveSummaryModel`、`finalTitle` は `finalSummaryModel`）と同じモデルにする。入っているかは、読み込んだときに Ollama に聞く（つながらなければ移行元と同じ）。古いキーは受け付けるが書き出さない（`PATCH` で送られても無視する）。
- 思考モードは処理ごとに固定する。参考資料セットの作成と最終の要約はオン、途中の要約はオフ。思考モードに対応していないモデルが選ばれた場合は、オフで実行する（9.3 節）。
- `whisper.speechThreshold` は、話しているかの判定のしかた（6.2 節）。`auto`（既定）は、音の大きさをそろえてから Silero VAD で声らしさを判定する。`manual` は `whisper.speechDbfs`（dBFS、-70〜-10）より大きい音を話し声とみなす。自動の結果が悪いときのために手動を残している。
- `whisper.finalTranscript` は、録音を終えたら最終の文字起こしを作るか（6.9 節、既定はオン）。サーバーに WhisperX が入っていないとき（`uv sync --extra final` していないとき）は、オンでも作らない。`whisper.diarize` は、最終の文字起こしで話者を分けるか（既定はオン）。話者分けのモデルを使えない（HuggingFace のトークンがない・利用条件に同意していない）ときは、分けずに作る。どちらも作り始める時点の値を使う。
- `recording.noiseSuppression`・`recording.autoGainControl`・`recording.echoCancellation` は、ブラウザのマイクの処理（`getUserMedia` の制約の同じ名前の項目）。サーバーは使わず、ブラウザが録音を始めるときに読む。既定はどれもオン（指定しなかったときのブラウザの既定と同じ）。録音の途中でマイクの処理が切り替わって文字起こしが止まるときに、切って試せるようにしてある（#120）。
- `recording.uploadMaxMb` は、アップロードできる音声ファイルの大きさの上限（MB、既定 2048。6.11 節）。
- `ollama.liveSummaryDensity`・`ollama.overviewDensity`・`ollama.detailDensity` は要約度（1〜5 の整数、既定は 3）。それぞれ途中の要約の区間ごとの要約（6.4 節）、最終の要約の全体の概要、最終の要約の区間ごとの要約（文字起こしが一度に収まるときは、その要約。6.5 節）に効く。3 は要約度を入れる前と同じ指示。詳細と途中の要約は残す細かさ（1: 要点だけに絞ってごく短く 〜 5: 数字・固有名詞・例・経緯まで残して細かく）を、概要は箇条書きの数（1: 2〜3 個、2: 3〜5 個、3: 5〜10 個、4: 8〜12 個、5: 10〜15 個）を変える。途中の要約の「ここまでの概要」は短いまま変えない。
- `ollama.pickTerms` は、録音中に文字起こしから用語を拾うか（6.2 節、#116）。途中の要約と同じ間隔で Ollama を呼ぶので録音中の GPU の負荷が上がり、既定はオフ。オンのときも、プロジェクトの `selection.pickTerms`（5.4 節）がオフなら拾わない。録音を始めるとき（続きの録音を含む）に見る（録音中に変えると、次の録音から効く）。
- `display.sessionMeta` は、左メニューのセッションのタイトルの下に、録音日時と長さを出すか（8 章）。既定は出さない。
- `display.showPickedTerms` は、文字起こしのタブに、録音中に拾った用語の一覧（`PickedTerms`）を出すか（#147）。既定は出さない。用語を拾うか（`ollama.pickTerms`）とは別の設定で、オフでも拾った語は今までどおり hotwords に使う。
- `display.showSpeakers` は、最終の文字起こしの行の頭の「話者 1」などの札と、世代の選択肢の「話者 N 人」を出すか（#146）。話者分けの精度がまだ低いので、既定は出さない。話者分け（`whisper.diarize`）の処理と保存するファイル（行の「話者 1: 」を含む）は変えず、画面の表示だけが変わる。文字起こしの書き出しの機能はない。
- `projectOrder` は、サイドバーのプロジェクトの並び順（プロジェクト ID の配列、既定は空。#173）。端末をまたいで同じ並びにするため、ブラウザではなくここに持つ。
  - 一覧（`GET /api/projects`）はこの順で返す（画面は並べ替えない）。`projectOrder` にないプロジェクト（新しく作ったもの・並び順を保存する前からあるもの）は先頭に置き、その中は ID の順。`projectOrder` にあって存在しない ID（消えたプロジェクト）は無視する（ファイルからは消さない）。同じ ID が重なっていたら最初のものだけ残す。
  - 画面でプロジェクトを並び替えたら、新しい並びをすべての ID で保存する（`PATCH /api/settings` に `{"projectOrder": [...]}` だけを送る）。並びが変わったら WebSocket で全員に `projectOrder` を送り、各端末は設定を取り直して、手元の一覧を並べ直す（知らないプロジェクトがあれば一覧ごと取り直す。7.2 節）。画面の全体設定の保存（`changeSettings`）は `projectOrder` を送らない（古い設定で、ほかの端末の並び替えを上書きしないため）。
  - 録音に関係ないので、**録音中も変えられる**（#133。録音中に変えられない項目の表にない）。
- 数値の既定値は仮のもので、実際に測ってから決める。

## 5.4 project.json

プロジェクトの索引と、そのプロジェクトで今選んでいる状態を記録する。書き込むときは、一時ファイルに書いてから rename する（アトミック書き込み）。

```json
{
  "version": 1,
  "uuid": "a7f19ad4-74c7-560d-8f96-d72f69c5953e",
  "path": "D:\\work\\meetings",
  "selection": {
    "contextSet": "20261009-090501",
    "useHotwords": true,
    "useContext": true,
    "pickTerms": true
  },
  "contextSets": [
    {
      "id": "20261009-090501",
      "status": "ready",
      "materials": ["D:\\work\\meetings\\weekly\\agenda.md", "D:\\work\\meetings\\weekly\\notes.md"]
    }
  ],
  "sessions": [
    {
      "id": "20261009-143012",
      "uuid": "9ce88ddf-db8e-5f9b-818e-11c3c80f9335",
      "title": "新機能のリリース計画",
      "status": "done",
      "startedAt": "2026-10-09T14:30:12+09:00",
      "endedAt": "2026-10-09T15:59:40+09:00",
      "durationSec": 5368,
      "contextSet": "20261009-090501"
    }
  ]
}
```

- `uuid` は画面の URL に出す ID（5.2 節）。ないものは読み込んだときに振って書き足す。
- `sessions` の `durationSec` は録音の長さ（秒、一時停止していた時間は含めない。文字起こしのフロントマターと同じ値）。録音中と、これを記録する前のセッションにはない（`null`）。

- 参考資料のパスは絶対パスで書く。参考資料は、プロジェクトのディレクトリの外（`materials.roots` の中）からも選べるため。
- `selection` がまだ保存されていないときは、`ready` のセットのうち最初に作ったものを選び、用語リストとコンテキストはどちらも使う。
- `selection.pickTerms` は、録音中に文字起こしから用語を拾って用語リストに足すか（6.2 節。既定はオン。参考資料セットがなくても使える）。全体設定の `ollama.pickTerms`（5.3 節、既定はオフ）もオンのときだけ効く。UI では、全体設定がオフの間はこのスイッチを切り替えられない。
- UI では、プロジェクトをディレクトリ名で表示する。
- 各ファイルの名前は ID から決まるので、ここには書かない。ファイルがあるかどうかは、実際にファイルを見て判定する。
- `project.json` が壊れたり消えたりした場合は、同じディレクトリにあるファイルのフロントマターを読んで作り直す。
  - プロジェクトのパスは、フロントマターの `project` から取る（5.5 節）。フロントマターを持つファイルが1つもなければ作り直せないので、もう一度登録する。
  - `selection` はほかのファイルに残っていないので、作り直すと既定（上の「まだ保存されていないとき」）に戻る。作成中・失敗した参考資料セットも、ファイルがないので載らない。
  - 壊れていたファイルは `project.json.broken-<日時>` という名前で残す。`version` がサーバーより新しいファイルは、作り直さずにエラーにする。
- `contextSets` と `sessions` は ID の昇順に並べる。
- **セッションを別のプロジェクトへ移す（#172）**: 録音を始めるプロジェクトを間違えたときのため。
  - 動かすのは、そのセッションのファイル（`recording-<ID>.*`・`transcript-<ID>.md`・`transcript-final-<ID>-*.md`・`summary-<ID>-*.md`・`.tmp/<ID>/`）。同じ home の下なので rename で動かす。
  - 使った参考資料セット（今のセットと、範囲で作り直す前のセット。6.12 節）の `hotwords-<ID>.md`・`context-<ID>.md` は、移動先にコピーして移動先の `contextSets` にも足す（作り直しで同じ用語リストを使えるように）。移動先に同じ ID があればコピーしない。セッション専用のセットは移動先でも選べる一覧には出ない。
  - 動かした文字起こし・最終の文字起こし・要約とコピーしたセットのフロントマターの `project` は移動先のパスにする（作り直した要約のコピーを移動先のディレクトリに置き、`project.json` を作り直せるように）。文字起こしには `uuid` も書き、作り直しても URL が変わらないようにする。
  - セッションの `uuid` は変えない（画面の URL `/s/<UUID>` はそのまま開ける）。
  - 両方の `project.json` を書き換える（移動先に足してから、元から外す）。途中で失敗したら、動かしたファイル・書き換えたファイル・`project.json` を元に戻し、元のプロジェクトに残す。
  - 選んだディレクトリに置いた最終の要約のコピー（`summary-YYYYMMDD-<タイトル>.md`）は動かさない（システムは読まないため）。
  - 移せないもの（`409`）: 録音中（ほかの端末のものも）・録音を終えたあとの処理中・浄書や最終の要約を作っている途中・GPU キューで待っている／実行中のジョブがあるセッション。移動先に同じ ID のセッションや同じ名前のファイルがあるとき。
- プロジェクトの一覧は、`projects/*/project.json` を読んで作る。ディレクトリをまたいで時系列に並べる表示が必要になったら、`history.jsonl`（追記のみ）を追加する。

## 5.5 フロントマター

日時はすべて、サーバーのローカルのタイムゾーン付きの ISO 8601 で書く（日本なら `+09:00`）。ID もローカルの時刻で作る。

どのファイルにも、プロジェクトのディレクトリの絶対パスを `project` として書く。`project.json` を作り直すときに使う（5.4 節）。

**用語リスト `hotwords-<ID>.md`**

```markdown
---
id: 20261009-090501
project: D:\work\meetings
createdAt: 2026-10-09T09:05:01+09:00
model: qwen3.5:4b
think: true
materials:
  - path: D:\work\meetings\weekly\agenda.md
    sha1: 3f2a...
  - path: D:\work\meetings\weekly\notes.md
    sha1: 9b1c...
---
リリース計画
ステージング環境
...
```

本文には1行に1語を書く。重要な語から順に並べる。Whisper に渡すときは「、」でつないで1行にする。

セッション専用のセット（6.12 節）には、`session`（そのセッションの ID）と `materialRange`（使った範囲。下の文字起こしと同じ形）が加わる。

**コンテキスト `context-<ID>.md`**: フロントマターは用語リストと同じ（このあとの `toc` が加わる）。本文は Markdown で書く。

`toc` は、参考資料ファイルごとの目次（6.6 節）。録音のあとに扱った範囲を選ぶとき（#182）に使う。用語リストには書かない。`toc` がないセット（目次ができる前に作ったもの）は、使うときに資料から取り出して書き足す。

```yaml
toc:
  - path: D:\work\meetings\weekly\textbook.pdf
    kind: pages          # pages（PDF のページ） | headings（見出し） | chunks（約 2000 文字ずつ）
    chars: 184300
    large: true          # 大きい資料（6.6 節）
    entries:             # 範囲は「資料＋始まり〜終わりの index」で表す
      - { index: 1, title: 第1章 はじめに, level: 1, chars: 1820 }
      - { index: 2, title: 第1章 はじめに, level: 1, chars: 2105 }
      # level は見出しの階層（1が最上位）。しおりのない PDF と chunks では null
```

**文字起こし `transcript-<ID>.md`**

```markdown
---
id: 20261009-143012
project: D:\work\meetings
uuid: 9ce88ddf-db8e-5f9b-818e-11c3c80f9335  # 別のプロジェクトへ移したとき（5.4 節）だけ書く。project.json を作り直しても URL を変えないため
title: 新機能のリリース計画
status: done            # recording | done | interrupted
startedAt: 2026-10-09T14:30:12+09:00
endedAt: 2026-10-09T15:59:40+09:00
durationSec: 5368
language: ja
whisper:
  model: large-v3-turbo
  beamSize: 5
  silenceMs: 600
  speechThreshold: auto
  speechDbfs: null            # speechThreshold が manual のときだけ値が入る
contextSet: 20261009-090501   # 使わなかった場合は null
useHotwords: true
recording: recording-20261009-143012.mp3
summaryFailed: false          # 最終の要約を作れなかったら true（作れたら false に戻す）
pickedTerms: [フォトンリンク]  # 録音中に文字起こしから拾って、用語リストに足した語（6.2 節）
rejectedTerms: []             # 画面で消された語（以後足さない）
manualTerms: [ハルシオン]      # 画面で手で足した語（6.2 節）。拾った語とは分けて持つ
corrections:                  # 文字起こしの置き換え（6.13 節）。line は「この行だけ」のときだけ
  - {from: 高橋件, to: 高橋健, line: null}
  - {from: 貴社, to: 記者, line: {transcript: final, generation: 20261009-150210, index: 12}}
appVersion: 2b23d9b           # 録音したサーバーのバージョン
source: upload                # 音声ファイルをアップロードして作ったセッション（6.11 節）。録音したものにはない
originalName: 会議.m4a        # アップロードした元のファイル名（アップロードのときだけ）
uploadedAt: 2026-10-10T09:00:00+09:00  # アップロードした日時（アップロードのときだけ。保存期間はここから数える）
materialRange:                # 今回扱った範囲で参考資料を作り直したとき（6.12 節）。from・to は目次の index で両端を含む
  - {file: slides.pdf, path: D:\work\slides.pdf, from: 12, to: 30}
baseContextSet: 20261009-090501  # 作り直したとき、元の（資料全体の）セット。contextSet はセッション専用のセットになる
---
[00:00:03] 今日はリリース計画について…
[00:00:15] …
```

`summaryFailed` は `project.json` の `sessions` の各行にも同じ値を書く（UI で失敗と作り直しを出すため）。`source`・`uploadedAt` も同じく `sessions` の各行に書く（サイドバーの印と保存期間のため）。

`appVersion` は、そのファイルを書いたサーバーのバージョン。バージョン番号は運用しないので、git のコミットハッシュ（短いもの）をバージョンとして扱う。サーバーを起動したときに `git rev-parse --short HEAD` で取り、コミットしていない変更（追跡しているファイルの変更）があれば `+dirty` を付ける（例: `2b23d9b+dirty`）。git が使えなければ `unknown`。項目のない古いファイルも読める。

**要約 `summary-<ID>-<生成 ID>.md`**

```markdown
---
id: 20261009-143012
generationId: 20261009-160203
project: D:\work\meetings
title: 新機能のリリース計画
startedAt: 2026-10-09T14:30:12+09:00
endedAt: 2026-10-09T15:59:40+09:00
model: qwen3.5:4b             # 要約詳細のモデル（6.5 節）
overviewModel: qwen3.5:4b     # 全体概要のモデル（#178）。項目のない古いファイルは model と同じとみなす
think: true
transcript: transcript-20261009-143012.md
contextSet: 20261009-090501
useContext: true
generatedAt: 2026-10-09T16:03:11+09:00
appVersion: 2b23d9b           # 要約を作ったサーバーのバージョン（文字起こしと同じ）
overviewDensity: 3            # 使った要約度（概要・詳細。5.3 節）。一度に収まって概要を作らなかったときは null。項目のない古いファイルも読める
detailDensity: 3
---
（要約の本文）
```

**最終の文字起こし `transcript-final-<ID>-<生成 ID>.md`**（6.9 節）

```markdown
---
id: 20261009-143012
generationId: 20261009-160011
project: D:\work\meetings
model: large-v3-turbo          # 使った Whisper のモデル
generatedAt: 2026-10-09T16:00:11+09:00
recording: recording-20261009-143012.mp3
alignModel: jonatasgrosman/wav2vec2-large-xlsr-53-japanese   # 単語の時刻を合わせたモデル
diarization: done              # done（話者を分けた）/ off（設定で切っていた）/ unavailable（モデルを使えなかった）
speakers: 2
appVersion: 2b23d9b
---
[00:00:03] 話者 1: 今日はリリース計画について決めていきたいと思います。
[00:00:08] 話者 2: まずステージング環境での確認ですが、来週の水曜日までに終わらせる予定です。
```
