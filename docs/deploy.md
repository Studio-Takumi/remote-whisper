# クラウド版のデプロイと環境

クラウド版の中間サーバー（`relay/`。Cloudflare Workers）と画面（`web/`）の環境と、デプロイ・戻し方の手順。仕様は [spec/cloud.md](spec/cloud.md) の 10 章。ダイレクト版（自分の PC だけで使う形）には関係しない。

## 環境

|                        | dev（ローカル）                        | staging                                                                             | production（本番）                                                     |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker                 | `wrangler dev`（`remote-whisper-dev`） | `remote-whisper-staging`                                                            | `remote-whisper`                                                       |
| URL                    | `http://localhost:8787`                | `https://rw-dev.studio-takumi.dev`                                                  | `https://rw.studio-takumi.dev`                                         |
| D1                     | ローカルだけ                           | `remote-whisper-staging`                                                            | `remote-whisper`                                                       |
| トンネルの公開ホスト名 | `rwt-local-<12 桁>.studio-takumi.dev`  | `rwt-dev-<12 桁>.studio-takumi.dev`                                                 | `rwt-<12 桁>.studio-takumi.dev`                                        |
| Analytics Engine       | 書かない                               | `remote_whisper_staging`                                                            | `remote_whisper`                                                       |
| デプロイ               | —                                      | 手で（Actions の Deploy を `staging` で動かす）。本番を用意するまでは main の自動も | main に入って CI が通ったら自動（`PRODUCTION_READY` が `true` のとき） |

設定は `relay/wrangler.jsonc`（`env.staging`・`env.production`）。秘密でない値（ドメイン・接頭辞）は `vars`、秘密の値は `wrangler secret`。

## 秘密情報の一覧

値はリポジトリ・PR・Issue・ログに書かない。`wrangler secret put <名前> --env <環境>` で入れる（値は標準入力から）。

| 置き場所                           | 名前                                         | 中身                                                                                                                         |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Worker の secret（環境ごと）       | `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`   | Google の OAuth のクライアント。リダイレクト URI は `<URL>/auth/callback/google`                                             |
|                                    | `DISCORD_CLIENT_ID`・`DISCORD_CLIENT_SECRET` | Discord の OAuth。リダイレクトは `<URL>/auth/callback/discord`                                                               |
|                                    | `GITHUB_CLIENT_ID`・`GITHUB_CLIENT_SECRET`   | GitHub の OAuth App。コールバックの URL は 1 つしか持てないので、環境ごとに別の App を作る（`<URL>/auth/callback/github`）   |
|                                    | `CF_API_TOKEN`                               | トンネルの操作（Account ／ Cloudflare Tunnel ／ Edit）と、`studio-takumi.dev` の DNS の編集（Zone ／ DNS ／ Edit）だけの権限 |
|                                    | `CF_ACCOUNT_ID`・`CF_ZONE_ID`                | 秘密ではないが、公開のリポジトリに置かないため secret にする                                                                 |
| GitHub Actions の secret           | `CLOUDFLARE_API_TOKEN`                       | デプロイ用。Account ／ Workers Scripts ／ Edit、Account ／ D1 ／ Edit、Zone ／ Workers Routes ／ Edit、Zone ／ Zone ／ Read  |
|                                    | `CLOUDFLARE_ACCOUNT_ID`                      | アカウントの ID                                                                                                              |
|                                    | `DISCORD_WEBHOOK_URL`（任意）                | デプロイに失敗したときの通知                                                                                                 |
| GitHub Actions の変数（Variables） | `PRODUCTION_READY`                           | `true` にすると、main の自動デプロイの行き先が本番になる                                                                     |

ローカルの `relay/.dev.vars`（git に入らない）には、localhost 専用の OAuth のクライアントだけを入れる。

## デプロイの流れ

1. PR を main にマージする
2. CI（`.github/workflows/ci.yml`）が通る
3. Deploy（`.github/workflows/deploy.yml`）が動き、行き先を決める（`PRODUCTION_READY` が `true` なら本番、そうでなければ staging）
4. 画面をビルドし（`VITE_CLOUD_HOSTS` に staging と本番のドメイン）、D1 のマイグレーションを当て（足すだけ）、`wrangler deploy` し、`/healthz` を確かめる
5. 失敗したら Actions が赤くなる（`DISCORD_WEBHOOK_URL` があれば Discord にも）

ブランチを staging で確かめるときは、Actions → Deploy → Run workflow でブランチを選び、行き先を `staging` にする。

本番の D1 の ID が仮のまま（`00000000-0000-0000-0000-000000000001`）だと、本番へのデプロイは「Production not ready」で止まる。本番に出せるのは main だけ（手動でほかのブランチを選ぶと「Not main」で止まる。下の GitHub の Environments でも守る）。

## 本番を一から用意する

匠の作業（アカウント・ドメイン・OAuth の画面での操作）を含む。上から順に。

1. **D1**: `cd relay && npx wrangler d1 create remote-whisper` を動かし、出てきた `database_id` を `relay/wrangler.jsonc` の `env.production.d1_databases` に書いて PR を出す（ID は秘密ではない）
2. **OAuth のクライアント**: Google・Discord は、今のクライアントのリダイレクト URI に `https://rw.studio-takumi.dev/auth/callback/<provider>` を足す（別のクライアントを作ってもよい）。GitHub は本番用の OAuth App を新しく作る
3. **GitHub の Environments**: GitHub → Settings → Environments で `production` を開き（デプロイを 1 回動かすと自動でできる。なければ New environment）、**Deployment branches and tags** を **Selected branches** にして `main` だけを足す。ブランチ側で workflow を書き換えられても、本番には main からしか出せなくなる。あわせて、本番だけ別の `CLOUDFLARE_API_TOKEN` を使うなら、その Environment の secret に入れる（Environment の secret はリポジトリの secret より先に使われる）
4. **Worker の secret**: 上の表の Worker の secret を `--env production` で入れる。Worker がまだないと「新しく作るか」を聞かれるので、手順 6 の最初のデプロイのあとに入れてもよい（その間はログインできない）。`CF_API_TOKEN` は staging と同じトークンでも動く（トンネルの名前と接頭辞が環境で分かれている）が、漏れたときの影響を分けるなら環境ごとにトークンを作る
5. **Analytics Engine**: アカウントで有効にしてあれば、`env.production` の `analytics_engine_datasets` を戻す（有効でないとデプロイが code 10089 で落ちる）
6. **最初のデプロイ**: Actions → Deploy → Run workflow で、main・行き先 `production` を選ぶ。カスタムドメイン `rw.studio-takumi.dev` は `routes` の `custom_domain` で Worker が付ける（DNS のレコードを手で作らなくてよい。デプロイ用のトークンに Zone ／ Workers Routes ／ Edit が要る。断られたら DNS の権限も見る）。`https://rw.studio-takumi.dev/healthz` が `{"ok":true,"env":"production",...}` を返すのを確かめる
7. **自動デプロイを本番に替える**: GitHub → Settings → Secrets and variables → Actions → Variables に `PRODUCTION_READY` = `true` を足す
8. **ホストの既定の接続先を本番にする**: `server/src/remote_whisper/settings.py` の `DEFAULT_RELAY_URL` と `web/src/settings.ts` の既定の `relayUrl` を `https://rw.studio-takumi.dev` にして PR を出す（すでに staging に登録したホストは、cloud.json の `relayUrl` を使い続ける）

## 戻し方

### まずい版を出したとき

- Worker を前の版に戻す: `cd relay && npx wrangler deployments list --env production` で版を見て、`npx wrangler rollback <版の ID> --env production --message "<理由>"`（ID を省くと 1 つ前。確認を飛ばすなら `-y`）。画面（静的アセット）も一緒に戻る
- 戻らないもの: D1 のマイグレーション（足すだけなので、古い版でも動く）と secret
- 戻した版は main とずれる。直した PR を main に入れれば、自動デプロイで新しい版が出て、ずれもなくなる

### デプロイに失敗したとき

- マイグレーションのあとで `wrangler deploy` が落ちたときは、古い Worker が動き続けている。マイグレーションは足すだけ（列や表を消す・名前を変えるものは 2 回に分けて出す）なので、古い Worker も壊れない。原因を直して出し直す
- `/healthz` が通らないときは、`wrangler tail --env production` でエラーを見る

### D1 のデータを戻すとき（Time Travel）

- D1 は保持期間の中の任意の時点に戻せる（期間はプランによる。無料プランは短い（7 日）ので、Cloudflare のドキュメントで今の値を確かめる）。`npx wrangler d1 time-travel info remote-whisper --env production` で今の bookmark を控えてから、`npx wrangler d1 time-travel restore remote-whisper --env production --timestamp <UNIX 秒か RFC3339>` で戻す
- 戻すとその時点より後の書き込み（ログイン・登録・同意）は消える。ユーザーに影響するので、戻す前に Worker を止める（`wrangler rollback` で古い版にする、など）かを決める
- staging で手順を一度試してから本番でやる
