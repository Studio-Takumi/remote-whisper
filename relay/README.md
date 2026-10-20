# relay（クラウド版の中間サーバー）

Cloudflare Workers で動く、クラウド版の中間サーバー。画面（`web/dist`）の配信・ログイン・ホストの登録・中継・計測をする。設計は [仕様書 10 章](../docs/spec/cloud.md)。ダイレクト版（LAN・Tailscale）では使わない。

## 構成

|                  |                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`   | Worker の入口。`run_worker_first` のパス（`/h/`・`/auth/`・`/me/`・`/pair`・`/healthz`）だけここに来る。ほかは静的アセット（`web/dist`、SPA） |
| `migrations/`    | D1 のマイグレーション（足すだけにする。列や表を消す・名前を変えるものは 2 回に分けて出す）                                                    |
| `test/`          | Vitest（`@cloudflare/vitest-plugin`。Workers の実行環境の中で、ローカルの D1 ごと動かす）                                                     |
| `wrangler.jsonc` | 環境ごとの設定。上の段はローカル用、`--env staging` は `rw-dev.studio-takumi.dev`                                                             |

## 開発

```sh
cd relay
npm ci
npm run migrate:local    # ローカルの D1 にマイグレーションを当てる（初回とマイグレーションを足したとき）
npm run dev              # http://127.0.0.1:8787 （画面は ../web/dist を配るので、先に web を npm run build しておく）
npm test
npm run lint && npm run format:check && npm run typecheck
```

- 秘密情報（OAuth のクライアントなど）は `relay/.dev.vars` に書く（git に入れない）。キーは `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`DISCORD_CLIENT_ID`・`DISCORD_CLIENT_SECRET`・`GITHUB_CLIENT_ID`・`GITHUB_CLIENT_SECRET`。ローカル（localhost）用のクライアントだけを入れる
- この端末の npm が古く（10.5）、`npm install` が落ちることがある。そのときは `npx npm@11 install`

## staging にデプロイする

main に入ったら自動でデプロイする（#170）。手で出すとき（ブランチを確かめるときだけ）:

```sh
cd web && npm run build && cd ../relay
npm run migrate:staging   # 本番の D1 に足すだけのマイグレーションを当てる
npm run deploy:staging    # https://rw-dev.studio-takumi.dev
curl https://rw-dev.studio-takumi.dev/healthz
```

- 先に `npx wrangler login`（`npx wrangler whoami` で確かめる）
- staging の秘密情報は `npx wrangler secret put <名前> --env staging`（値は標準入力で渡し、画面やログに出さない）。入っているものは `npx wrangler secret list --env staging`
- workers.dev の URL は使わない（`workers_dev: false`）。画面がクラウド版と判定するのは `rw-dev.studio-takumi.dev` だけのため
- 本番（`--env production`）は #167 で足す
