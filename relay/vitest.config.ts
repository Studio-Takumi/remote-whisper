// Workers の実行環境（workerd）の中でテストを動かす。D1 はローカルのものを使い、マイグレーションを当ててから始める
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// テストの中（workerd）からはファイルを読めないので、突き合わせに使うファイルの中身をここで読んで渡す（#495。test/errors.test.ts）。
// web の辞書がなければ（relay だけを取り出したとき）空の文字列にし、そのテストは飛ばす
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const WEB_ERRORS = '../web/src/api/relayErrors/i18n';
const relaySource = readdirSync('./src')
    .filter((name) => name.endsWith('.ts') && name !== 'errors.ts')
    .map((name) => readFileSync(`./src/${name}`, 'utf8'))
    .join('\n');

export default defineConfig({
    plugins: [
        cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                    // テスト用の偽の OAuth のクライアント（.dev.vars があっても、こちらを使う）
                    GOOGLE_CLIENT_ID: 'google-id',
                    GOOGLE_CLIENT_SECRET: 'google-secret',
                    DISCORD_CLIENT_ID: 'discord-id',
                    DISCORD_CLIENT_SECRET: 'discord-secret',
                    GITHUB_CLIENT_ID: 'github-id',
                    GITHUB_CLIENT_SECRET: 'github-secret',
                    // トンネルの API（偽物に差し替える）
                    CF_API_TOKEN: 'cf-token',
                    CF_ACCOUNT_ID: 'acct',
                    CF_ZONE_ID: 'zone',
                    // エラーの文の突き合わせ（#495）
                    TEST_WEB_ERRORS_JA: read(`${WEB_ERRORS}/ja.ts`),
                    TEST_WEB_ERRORS_EN: read(`${WEB_ERRORS}/en.ts`),
                    TEST_RELAY_SOURCE: relaySource,
                },
            },
        })),
    ],
    test: {
        setupFiles: ['./test/apply-migrations.ts'],
    },
});
