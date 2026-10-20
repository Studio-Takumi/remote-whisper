// テストの前に、ローカルの D1 にマイグレーションを当てる
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
