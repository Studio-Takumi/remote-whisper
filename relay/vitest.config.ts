// Workers の実行環境（workerd）の中でテストを動かす。D1 はローカルのものを使い、マイグレーションを当ててから始める
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// このファイルからのパス（リポジトリの直下から -c relay/vitest.config.ts で動かしても同じ所を指すように）
const DIR = dirname(fileURLToPath(import.meta.url));
const here = (path: string) => join(DIR, path);

// テストの中（workerd）からはファイルを読めないので、突き合わせに使うファイルの中身をここで読んで渡す（#495。test/errors.test.ts）。
// web がなければ（relay だけを取り出したとき）空の文字列にし、そのテストは飛ばす。web があるのに辞書がないときは
// （辞書を移した・名前を変えたなど）、突き合わせが黙って止まらないように、ここで止める
function readWebDictionary(file: string): string {
    if (!existsSync(here('../web'))) {
        return '';
    }
    const path = here(`../web/src/api/relayErrors/i18n/${file}`);
    if (!existsSync(path)) {
        throw new Error(
            `relay のエラーの辞書がありません: web/src/api/relayErrors/i18n/${file}（移したなら vitest.config.ts も直す）`,
        );
    }
    return readFileSync(path, 'utf8');
}

// relay の src（ファイル名と中身）。errors.ts（文の置き場所）も入れる。テストの側で分ける
const relaySource = Object.fromEntries(
    readdirSync(here('./src'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => [name, readFileSync(here(`./src/${name}`), 'utf8')]),
);

export default defineConfig({
    plugins: [
        cloudflareTest(async () => ({
            wrangler: { configPath: here('./wrangler.jsonc') },
            miniflare: {
                bindings: {
                    TEST_MIGRATIONS: await readD1Migrations(here('./migrations')),
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
                    TEST_WEB_ERRORS_JA: readWebDictionary('ja.ts'),
                    TEST_WEB_ERRORS_EN: readWebDictionary('en.ts'),
                    TEST_RELAY_SOURCE: relaySource,
                },
            },
        })),
    ],
    test: {
        setupFiles: [here('./test/apply-migrations.ts')],
    },
});
