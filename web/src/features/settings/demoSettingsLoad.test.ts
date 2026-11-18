// 同梱したデータのデモ版（#415）で、設定を読み込むところ。同梱データがあるデモ版として読み込む
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoServer } from '@/api/demoServer';
import type { DemoIndex } from '@/api/demoTypes';
import { DEMO_DISPLAY_KEY } from '@/features/settings/demoDisplay';

vi.mock('@/api/demoBuild', () => ({ isDemoBuild: true }));
vi.mock('@/api/demo', () => {
    const index: DemoIndex = {
        projects: [],
        sessions: {},
        contextSets: {},
        settings: {
            ollama: { models: { overview: 'qwen3.5:4b', detail: 'qwen3.5:4b' } },
            display: { sessionMeta: false, showSpeakers: true },
            cloud: { relayUrl: '' },
        },
    };
    return {
        isDemo: true,
        usesMockData: false,
        demoServer: new DemoServer(index, () => null),
    };
});

const { useAppStore } = await import('@/app/store');

beforeEach(() => {
    localStorage.clear();
});

describe('同梱したデータのデモ版の設定の読み込み', () => {
    it('読み終わるまでは未読み込みで、読むと setting.json の値になる', async () => {
        // 開いた設定の下書きが、既定値のまま古くならないように
        expect(useAppStore.getState().settingsLoaded).toBe(false);
        await useAppStore.getState().loadSettings();
        const { settings, settingsLoaded } = useAppStore.getState();
        expect(settingsLoaded).toBe(true);
        expect(settings.ollama.models.overview).toBe('qwen3.5:4b');
        expect(settings.display.showSpeakers).toBe(true);
        // relayUrl が空でも読める（cloud は既定値のまま）
        expect(settings.cloud.relayUrl).not.toBe('');
    });

    it('この端末で変えた表示の設定が、同梱した値に重なる', async () => {
        localStorage.setItem(DEMO_DISPLAY_KEY, JSON.stringify({ sessionMeta: true, showSpeakers: false }));
        await useAppStore.getState().loadSettings();
        const { settings } = useAppStore.getState();
        expect(settings.display).toMatchObject({ sessionMeta: true, showSpeakers: false });
        // 表示以外は同梱した値のまま
        expect(settings.ollama.models.detail).toBe('qwen3.5:4b');
    });

    it('選べる値も同梱の答えから読む', async () => {
        await useAppStore.getState().loadOptions();
        expect(useAppStore.getState().options.llm.models.map((m) => m.name)).toContain('gemma4:e2b');
    });
});
