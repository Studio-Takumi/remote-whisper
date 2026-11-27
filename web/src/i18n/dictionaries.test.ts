import { describe, expect, it } from 'vitest';

import type { Dictionary } from '@/i18n/messages';

// すべての辞書（src/**/i18n/）で、ja と en のキーがそろっているか（#497）。
// defineTranslation の型は ja にないキーと {} の食い違いを止めるが、en の欠けは止めないので、ここで落とす
const jaModules = import.meta.glob<Dictionary>('/src/**/i18n/ja.ts', { eager: true, import: 'ja' });
const enModules = import.meta.glob<Dictionary>('/src/**/i18n/en.ts', { eager: true, import: 'en' });
const enSources = import.meta.glob<string>('/src/**/i18n/en.ts', { eager: true, query: '?raw', import: 'default' });

const folders = Object.keys(jaModules).map((path) => path.replace(/\/ja\.ts$/, ''));

function placeholders(message: string): string[] {
    return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

describe('辞書の ja と en', () => {
    it('辞書が見つかる', () => {
        expect(folders.length).toBeGreaterThan(10);
    });

    it.each(folders)('%s: ja.ts と en.ts の両方がある', (folder) => {
        expect(enModules[`${folder}/en.ts`]).toBeDefined();
    });

    it.each(folders)('%s: en のキーが ja とそろっている', (folder) => {
        const ja = jaModules[`${folder}/ja.ts`];
        const en = enModules[`${folder}/en.ts`] ?? {};
        expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
    });

    it.each(folders)('%s: en の文の {} が ja と同じ・空でない', (folder) => {
        const ja = jaModules[`${folder}/ja.ts`];
        const en = enModules[`${folder}/en.ts`] ?? {};
        for (const [key, message] of Object.entries(en)) {
            const source = ja[key];
            if (typeof message === 'string' && typeof source === 'string') {
                expect({ key, names: placeholders(message) }).toEqual({ key, names: placeholders(source) });
            }
            if (typeof message === 'string' && message.trim() === '') {
                // 前後の部品の間に何も挟まないキー（英語では語順が変わるため）だけ空にしてよい
                expect(emptyAllowed).toContain(`${folder}:${key}`);
            }
        }
    });

    it.each(folders)('%s: en.ts は defineTranslation で作る（{} の突き合わせを型で効かせるため）', (folder) => {
        expect(enSources[`${folder}/en.ts`]).toMatch(/defineTranslation<typeof ja>\(\)\(/);
    });
});

// 英語では要らない、文の切れ端
const emptyAllowed = ['/src/features/setup/i18n:llmStep.lmStudioStartAfter'];
