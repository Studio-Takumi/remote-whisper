// テストの env の型（cloudflare:test の env は Cloudflare.Env）
import type { Env as WorkerEnv } from '../src/index';

declare global {
    namespace Cloudflare {
        interface Env extends WorkerEnv {
            TEST_MIGRATIONS: D1Migration[];
        }
    }
}
