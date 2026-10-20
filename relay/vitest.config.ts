// Workers の実行環境（workerd）の中でテストを動かす。D1 はローカルのものを使い、マイグレーションを当ててから始める
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

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
                },
            },
        })),
    ],
    test: {
        setupFiles: ['./test/apply-migrations.ts'],
    },
});
