import type { SettingsOptions } from '@/protocol';

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

// 思考モードを使う処理（最終の要約・参考資料セット）の説明。対応していないモデルはオフで実行する（spec 5.3・9.3）
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
