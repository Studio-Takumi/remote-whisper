import type { SettingsOptions } from '@/protocol';
import type { OllamaModels } from '@/settings';

// 設定で選べる値（GET /api/settings/options）を取る
export async function fetchOptions(): Promise<SettingsOptions> {
    const res = await fetch('/api/settings/options');
    if (!res.ok) {
        throw new Error(`GET /api/settings/options: ${res.status}`);
    }
    return res.json();
}

// 選択肢の一覧。今の設定値が一覧になくても選んだ状態で出せるように、足しておく
export function withCurrent(options: string[], ...current: string[]) {
    return [...new Set([...options, ...current])];
}

export function ollamaModelNames(options: SettingsOptions) {
    return options.ollama.models.map((m) => m.name);
}

// 処理ごとのモデルが Ollama に入っていないか。一覧が取れていれば入っているものと突き合わせ、
// 取れていなければサーバーが返した ollama.missing を見る（#179）
export function isMissing(options: SettingsOptions, key: keyof OllamaModels, model: string) {
    const names = ollamaModelNames(options);
    return names.length > 0 ? !names.includes(model) : (options.ollama.missing?.includes(key) ?? false);
}

// 思考モードを使う処理（最終の要約・参考資料セット）の説明。対応していないモデルはオフで実行する（spec/files.md 5.3・spec/notes.md 9.3）
export function thinkingNote(options: SettingsOptions, model: string) {
    const thinking = options.ollama.models.find((m) => m.name === model)?.thinking;
    if (thinking === false) {
        return 'このモデルは思考モードに対応していないため、オフで実行します';
    }
    if (thinking === undefined) {
        return '思考モードはオン（対応していないモデルではオフで実行します）';
    }
    return '思考モードはオン';
}
