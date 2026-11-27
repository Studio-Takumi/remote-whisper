// テストの env の型（cloudflare:test の env は Cloudflare.Env）
import type { Env as WorkerEnv } from '../src/index';

declare global {
    namespace Cloudflare {
        interface Env extends WorkerEnv {
            TEST_MIGRATIONS: D1Migration[];
            // web の relay のエラーの辞書（ja.ts・en.ts）の中身と、relay の src の中身（#495。vitest.config.ts）
            TEST_WEB_ERRORS_JA: string;
            TEST_WEB_ERRORS_EN: string;
            TEST_RELAY_SOURCE: string;
        }
    }
}
