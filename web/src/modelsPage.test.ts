import { describe, expect, it } from 'vitest';

import { isMissing } from '@/options';
import type { SettingsOptions } from '@/protocol';
import { SETTINGS_PAGES, defaultSettings, recommendedModels } from '@/settings';

const options = (names: string[], missing?: string[]): SettingsOptions => ({
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16'] },
    ollama: { models: names.map((name) => ({ name, thinking: true })), missing },
});

describe('isMissing', () => {
    it('入っているモデルの一覧にあるかで決める', () => {
        const o = options(['qwen3.5:4b']);
        expect(isMissing(o, 'detail', 'qwen3.5:4b')).toBe(false);
        expect(isMissing(o, 'liveSummary', 'qwen3.5:2b')).toBe(true);
    });

    it('一覧が取れていないときは、サーバーが返した missing を見る', () => {
        const o = options([], ['scope']);
        expect(isMissing(o, 'scope', 'qwen3.5:4b')).toBe(true);
        expect(isMissing(o, 'detail', 'qwen3.5:4b')).toBe(false);
        expect(isMissing(options([]), 'detail', 'qwen3.5:4b')).toBe(false);
    });
});

describe('モデルのページ', () => {
    it('URL のページに models がある', () => {
        expect(SETTINGS_PAGES).toContain('models');
    });

    it('おすすめは Ollama の処理すべてに決まっている', () => {
        expect(Object.keys(recommendedModels).sort()).toEqual(Object.keys(defaultSettings.ollama.models).sort());
    });
});
