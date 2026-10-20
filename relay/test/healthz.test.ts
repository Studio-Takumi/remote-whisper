import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/healthz', () => {
    it('生きていて、DB に届く', async () => {
        const res = await SELF.fetch('http://example.com/healthz');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, env: 'dev', db: true });
    });

    it('ほかのパスは 404（中継・ログイン・登録はそれぞれの Issue で足す）', async () => {
        const res = await SELF.fetch('http://example.com/h/host/api/version');
        expect(res.status).toBe(404);
    });
});

describe('マイグレーション', () => {
    const tables = ['users', 'auth_identities', 'web_sessions', 'hosts', 'pairing_requests', 'consents'];

    it('6 つの表ができている', async () => {
        const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
            name: string;
        }>();
        const names = rows.results.map((r) => r.name);
        for (const table of tables) {
            expect(names).toContain(table);
        }
    });

    it('同じプロバイダの同じ ID は 1 つだけ', async () => {
        const now = Date.now();
        await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
            .bind('u1', 'テスト', now)
            .run();
        const insert = env.DB.prepare(
            'INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)',
        );
        await insert.bind('a1', 'u1', 'github', '123', now).run();
        await expect(insert.bind('a2', 'u1', 'github', '123', now).run()).rejects.toThrow();
    });
});
