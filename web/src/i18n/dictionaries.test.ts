import { describe, expect, it } from 'vitest';

import { contentLang } from '@/i18n/contentLang';
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

    // 単数・複数などで関数にした訳を、ja の {} の名前で 1 と 2 を渡して呼ぶ（引数の名前の取り違えを見つける）
    it.each(folders)('%s: en の関数の訳は、1 と 2 で文になる', (folder) => {
        const ja = jaModules[`${folder}/ja.ts`];
        const en = enModules[`${folder}/en.ts`] ?? {};
        for (const [key, message] of Object.entries(en)) {
            const source = ja[key];
            if (typeof message !== 'function' || typeof source !== 'string') {
                continue;
            }
            for (const n of [1, 2]) {
                const params = Object.fromEntries(placeholders(source).map((name) => [name, n]));
                const text = (message as (p: Record<string, number>) => string)(params);
                expect({ key, n, text }).toEqual({ key, n, text: expect.not.stringMatching(/undefined|NaN|\{/) });
            }
        }
    });

    // ja の文をそのまま写した・訳し忘れたものを見つける
    it.each(folders)('%s: en の文に仮名・漢字・和文の約物が残っていない', (folder) => {
        const en = enModules[`${folder}/en.ts`] ?? {};
        for (const [key, message] of Object.entries(en)) {
            if (typeof message === 'string' && (contentLang(message) || /[、。「」（）]/.test(message))) {
                expect(japaneseAllowed).toContain(`${folder}:${key}`);
            }
        }
    });
});

// 英語では要らない、文の切れ端
const emptyAllowed = ['/src/features/setup/i18n:llmStep.lmStudioStartAfter'];

// 英語の文でも、日本語の文字そのものを出すもの（使えない文字の説明など）
const japaneseAllowed = ['/src/api/serverErrors/i18n:termList.invalidTerm'];
