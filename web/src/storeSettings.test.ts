import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api';
import { defaultSettings } from '@/settings';
import { useAppStore } from '@/store';

// 設定を読み終わる前・読めなかったときに保存しても、既定値でサーバーの設定を上書きしない（#339）
describe('changeSettings', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        useAppStore.setState({ settings: defaultSettings, settingsLoaded: false });
    });

    it('読み終わる前は PATCH を送らない', async () => {
        const patch = vi.spyOn(api, 'patch');
        expect(await useAppStore.getState().changeSettings(defaultSettings)).toBe(false);
        expect(patch).not.toHaveBeenCalled();
    });

    it('読むのに失敗したあとも PATCH を送らない', async () => {
        vi.spyOn(api, 'get').mockRejectedValue(new Error('down'));
        const patch = vi.spyOn(api, 'patch');
        await useAppStore.getState().loadSettings();
        expect(useAppStore.getState().settingsLoaded).toBe(false);
        expect(await useAppStore.getState().changeSettings(defaultSettings)).toBe(false);
        expect(patch).not.toHaveBeenCalled();
    });

    it('読み終わってからは今までどおり保存できる', async () => {
        const loaded = { ...defaultSettings, llm: { backend: 'lmstudio' as const } };
        vi.spyOn(api, 'get').mockResolvedValue(loaded);
        const patch = vi
            .spyOn(api, 'patch')
            .mockImplementation(async (_p, body) => ({ ...loaded, ...(body as object) }));
        await useAppStore.getState().loadSettings();
        expect(useAppStore.getState().settingsLoaded).toBe(true);
        const next = {
            ...useAppStore.getState().settings,
            display: { ...loaded.display, sessionMeta: !loaded.display.sessionMeta },
        };
        expect(await useAppStore.getState().changeSettings(next)).toBe(true);
        expect(patch).toHaveBeenCalledTimes(1);
        expect((patch.mock.calls[0][1] as { llm: unknown }).llm).toEqual({ backend: 'lmstudio' });
    });
});
