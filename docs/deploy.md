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
3. **GitHub の Environments**: GitHub → Settings → Environments で `production` を開き（デプロイを 1 回動かすと自動でできる。なければ New environment）、**Deployment branches and tags** を **Selected branches** にして `main` だけを足す。そのうえで、本番を触れる Cloudflare のトークン（本番の D1 と Worker を編集できるもの）は **production の Environment の secret にだけ** 置き、リポジトリの secret（どのブランチの workflow からも読める）には置かない。ただし、Cloudflare の Workers と D1 の権限はアカウント単位で、同じアカウントの中で「staging だけを編集できるトークン」は作れない。staging のデプロイ用のトークンも本番の Worker と D1 を編集できてしまうので、リポジトリの secret に置いた staging 用のトークンを使えば、ブランチの workflow から本番を書き換えられることは残る。本当に分けるなら、本番を別の Cloudflare のアカウントに置く（そのアカウントのトークンを production の Environment の secret にだけ置く）。それまでは、リポジトリに書き込める人（今は匠だけ）を信頼する前提とする
4. **Worker の secret**: 上の表の Worker の secret を `--env production` で入れる。Worker がまだないと「新しく作るか」を聞かれるので、手順 6 の最初のデプロイのあとに入れてもよい（その間はログインできない）。`CF_API_TOKEN` は staging と同じトークンでも動く（トンネルの名前と接頭辞が環境で分かれている）が、漏れたときの影響を分けるなら環境ごとにトークンを作る
5. **Analytics Engine**: アカウントで有効にしてあれば、`env.production` の `analytics_engine_datasets` を戻す（有効でないとデプロイが code 10089 で落ちる）
6. **最初のデプロイ**: Actions → Deploy → Run workflow で、main・行き先 `production` を選ぶ。カスタムドメイン `rw.studio-takumi.dev` は `routes` の `custom_domain` で Worker が付ける（DNS のレコードを手で作らなくてよい。デプロイ用のトークンに Zone ／ Workers Routes ／ Edit が要る。断られたら DNS の権限も見る）。`https://rw.studio-takumi.dev/healthz` が `{"ok":true,"env":"production",...}` を返すのを確かめる
7. **自動デプロイを本番に替える**: GitHub → Settings → Secrets and variables → Actions → Variables に `PRODUCTION_READY` = `true` を足す
8. **ホストの既定の接続先を本番にする**: `server/src/remote_whisper/settings.py` の `DEFAULT_RELAY_URL` と `web/src/settings.ts` の既定の `relayUrl` を `https://rw.studio-takumi.dev` にして PR を出す（すでに staging に登録したホストは、cloud.json の `relayUrl` を使い続ける）

## WAF のレート制限（#166）

Worker の中の回数の制限（申請・ポーリング・`/pair/tunnel`・ホスト数・一覧の状態の覚え方）は、isolate ごと・ホストごとのもので、たくさんの IP や PoP から来られると全体では効かない。全体の回数は Cloudflare の WAF で守る（ダッシュボードの設定なので匠の作業）。

1. Cloudflare → `studio-takumi.dev` → Security → WAF → Rate limiting rules → Create rule
2. 対象: Hostname が `rw-dev.studio-takumi.dev`（本番は `rw.studio-takumi.dev`）で、URI Path が `/auth/` か `/pair/` で始まるもの、または `/me/hosts`
3. 回数: 同じ IP から 10 秒に 20 回（無料プランで選べる範囲）を超えたら、10 秒 Block
4. 画面の静的アセットと `/h/`（中継）は対象にしない（録音中の API を止めないため）

`/csp-report`（CSP の違反の報告。#253）は、Worker の Rate Limiting の束縛（`relay/wrangler.jsonc` の `ratelimits`。接続元ごとに 1 分に 20 回）で数える。これも PoP ごとの数なので、全体を絞りたくなったら上のルールの対象に `/csp-report` を足す。

## CSP の違反を見る（#253）

画面の CSP は強制（`web/public/_headers`）で、違反するとブラウザが `/csp-report` に報告を送る。Worker は数だけを Analytics Engine に書く（`blob1` が `csp_violation`。列は [spec/cloud.md](spec/cloud.md) 10.9 節の「CSP の違反の形」）。クエリ・スクリプトの抜粋・IP アドレスは残らない。

1. Cloudflare → Workers & Pages → Analytics Engine → SQL（または SQL API）で、データセット `remote_whisper_staging`（本番は `remote_whisper`）に次を投げる

    ```sql
    SELECT blob2 AS directive, blob3 AS disposition, blob4 AS page, blob5 AS blocked, blob6 AS browser, blob7 AS os,
           sum(_sample_interval * double1) AS n
    FROM remote_whisper_staging
    WHERE blob1 = 'csp_violation' AND timestamp > now() - INTERVAL '7' DAY
    GROUP BY directive, disposition, page, blocked, browser, os ORDER BY n DESC LIMIT 50;
    ```

2. 読み方
    - `disposition` が `enforce` の行は、ブラウザが止めたもの（画面の何かが動いていないかもしれない）。デプロイの直後に増えたら、まずその版を疑う（下の「戻し方」）
    - `blocked` が `inline` で `directive` が `script-src-elem` なら、index.html のインラインのスクリプトのハッシュが合っていない（`web/src/headers.test.ts` が通っているかを見る）か、Cloudflare のゾーンの機能が HTML にインラインのスクリプトを差し込んでいる。Bot Fight Mode・JavaScript detections（`/cdn-cgi/challenge-platform/`）・Email Address Obfuscation・Rocket Loader・Web Analytics などで、どれも同じ行になる。ハッシュが合っていれば、`studio-takumi.dev` のゾーンの設定（Security・Scrape Shield・Speed）で、`rw-dev`・`rw` に効いている機能を見る
    - `blocked` が `self:wss` で `directive` が `connect-src` なら、そのブラウザが `connect-src 'self'` を同じホストの `wss:` に当てていない（Safari の古い版など）。`_headers` の `connect-src` に `wss://<ホスト名>` を足すことを考える
    - `blocked` が `https://static.cloudflareinsights.com/...` なら、Cloudflare の Web Analytics（RUM）が画面にスクリプトを自動で差し込んでいる。CSP は自分のオリジンのスクリプトしか許さないので、ブラウザが止める（画面の動きには関係ない）。使わないので、Cloudflare → Web Analytics（または `studio-takumi.dev` → Speed → Settings）で、`rw-dev.studio-takumi.dev`・`rw.studio-takumi.dev` の自動の差し込みを切る（#253 の時点で staging に入っていた）。使うことにするなら、`_headers` の `script-src` に `https://static.cloudflareinsights.com`、`connect-src` に `https://cloudflareinsights.com` を足す（仕様の 10.9 節の「数値だけ」とも照らす）
    - `blocked` が `chrome-extension`・`moz-extension`・`safari-web-extension` などは、ユーザーの拡張機能が差し込んだもの。こちらでは直さない
    - 1 人のブラウザが何度も送ることがあるので、件数は目安（接続元ごとに 1 分に 20 回までしか受けない）
    - 報告はログインなしで誰でも送れるので、偽の報告で数を汚せる（好きなディレクティブ名・オリジンの行を作れる。害はそれだけ）。少しだけの見慣れない行は偽物のこともある
3. 報告が来ているかだけを見るときは、HTTP の計測の行（`blob1` が `csp`・`blob3` が `/csp-report`）の件数を見る

新しいポリシー（たとえば `style-src` から `'unsafe-inline'` を外す）を試すときは、`_headers` の強制の行はそのままにして、`Content-Security-Policy-Report-Only` の行を同じ `report-uri /csp-report` 付きで足す。報告は `disposition` が `report` の行として数えられるので、しばらく staging（と本番）で集めてから、強制の行に移す。ローカルでは、`cd web && npm run check:csp -- --headers <試す _headers>` で主な画面を Chromium と WebKit で回せる。

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
