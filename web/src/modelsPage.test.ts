import { describe, expect, it } from 'vitest';

import { isMissing, llmModelNames } from '@/options';
import type { SettingsOptions } from '@/protocol';
import {
    type LlmBackend,
    SETTINGS_PAGES,
    defaultSettings,
    llmBackend,
    llmModels,
    recommendedLmStudioModels,
    recommendedModels,
    recommendedModelsFor,
} from '@/settings';

const options = (names: string[], missing?: string[], backend: LlmBackend = 'ollama'): SettingsOptions => ({
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16'] },
    llm: { backend, models: names.map((name) => ({ name, thinking: true })), missing },
});

describe('isMissing', () => {
    it('入っているモデルの一覧にあるかで決める', () => {
        const o = options(['qwen3.5:4b']);
        expect(isMissing(o, 'ollama', 'detail', 'qwen3.5:4b')).toBe(false);
        expect(isMissing(o, 'ollama', 'liveSummary', 'qwen3.5:2b')).toBe(true);
    });

    it('一覧が取れていないときは、サーバーが返した missing を見る', () => {
        const o = options([], ['scope']);
        expect(isMissing(o, 'ollama', 'scope', 'qwen3.5:4b')).toBe(true);
        expect(isMissing(o, 'ollama', 'detail', 'qwen3.5:4b')).toBe(false);
        expect(isMissing(options([]), 'ollama', 'detail', 'qwen3.5:4b')).toBe(false);
    });

    it('一覧が別のバックエンドのもの（保存する前に切り替えた）なら、分からないので出さない（#327）', () => {
        const o = options(['qwen3.5:4b'], ['detail'], 'ollama');
        expect(isMissing(o, 'lmstudio', 'detail', 'google/gemma-4-e4b')).toBe(false);
        expect(llmModelNames(o, 'lmstudio')).toEqual([]);
        expect(llmModelNames(o, 'ollama')).toEqual(['qwen3.5:4b']);
    });
});

describe('モデルのページ', () => {
    it('URL のページに models がある', () => {
        expect(SETTINGS_PAGES).toContain('models');
    });

    it('おすすめは Ollama の処理すべてに決まっている', () => {
        expect(Object.keys(recommendedModels).sort()).toEqual(Object.keys(defaultSettings.ollama.models).sort());
        expect(Object.keys(recommendedLmStudioModels).sort()).toEqual(Object.keys(recommendedModels).sort());
    });

    it('選んでいるバックエンドのモデルを読む（#327）', () => {
        const ollama = { ...defaultSettings, llm: { backend: 'ollama' as const } };
        const lmstudio = { ...defaultSettings, llm: { backend: 'lmstudio' as const } };
        expect(llmModels(ollama).detail).toBe('gemma4:e4b');
        expect(llmModels(lmstudio).detail).toBe('google/gemma-4-e4b');
        expect(llmModels(lmstudio).liveSummary).toBe('qwen/qwen3.5-2b');
        expect(recommendedModelsFor('lmstudio')).toBe(recommendedLmStudioModels);
        // 古いサーバー（llm・lmstudio がない）は Ollama
        const { llm: _llm, lmstudio: _lms, ...old } = defaultSettings;
        expect(llmBackend({ ...old, llm: undefined })).toBe('ollama');
        expect(llmModels({ ...old, llm: { backend: 'lmstudio' } }).detail).toBe('gemma4:e4b');
    });
});
