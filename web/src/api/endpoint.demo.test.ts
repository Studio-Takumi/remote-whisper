import { describe, expect, it, vi } from 'vitest';

import { apiUrl, healthzUrl, wsUrl } from '@/api/endpoint';

// デモ版のビルド（#413）として読み込む
vi.mock('@/api/demoBuild', () => ({ isDemoBuild: true }));

describe('デモ版のビルド', () => {
    it('API と WebSocket の URL を作ろうとしたら例外にする（サーバーにつながない）', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => apiUrl('/api/projects', 'direct', null)).toThrow(
            'デモ版はサーバーにつながりません: /api/projects',
        );
        expect(() => wsUrl({ protocol: 'https:', host: 'example.com' }, 'direct', null)).toThrow(
            'デモ版はサーバーにつながりません: /ws',
        );
        // ホストに属さないパスは今までどおり
        expect(healthzUrl()).toBe('/healthz');
    });
});
