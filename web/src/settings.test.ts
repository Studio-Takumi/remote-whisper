import { describe, expect, it } from 'vitest';

import { defaultSettings, finalModelLabel, isCurrentFinalSummary } from '@/settings';

const models = { ...defaultSettings.ollama.models, overview: 'qwen3.5:4b', detail: 'qwen3.5:4b' };

describe('isCurrentFinalSummary', () => {
    it('全体概要と要約詳細のモデルの組が同じなら今のもの', () => {
        expect(isCurrentFinalSummary({ model: 'qwen3.5:4b', overviewModel: 'qwen3.5:4b' }, models)).toBe(true);
        expect(isCurrentFinalSummary({ model: 'qwen3.5:4b', overviewModel: 'qwen3.5:2b' }, models)).toBe(false);
        expect(isCurrentFinalSummary({ model: 'gemma3:4b' }, models)).toBe(false);
    });

    it('全体概要のモデルを記録する前の要約は、要約詳細と同じとみなす', () => {
        expect(isCurrentFinalSummary({ model: 'qwen3.5:4b' }, models)).toBe(true);
    });
});

describe('finalModelLabel', () => {
    it('同じなら 1 つ、違えば両方', () => {
        expect(finalModelLabel(models)).toBe('qwen3.5:4b');
        expect(finalModelLabel({ ...models, overview: 'qwen3.5:2b' })).toBe('qwen3.5:2b / qwen3.5:4b');
    });
});
