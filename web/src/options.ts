import { apiUrl } from '@/endpoint';
import type { SettingsOptions } from '@/protocol';
import type { LlmBackend, OllamaModels } from '@/settings';

// 設定で選べる値（GET /api/settings/options）を取る
export async function fetchOptions(): Promise<SettingsOptions> {
    const res = await fetch(apiUrl('/api/settings/options'));
    if (!res.ok) {
        throw new Error(`GET /api/settings/options: ${res.status}`);
    }
    const body = await res.json();
    // #325 より前のサーバーは llm がなく、同じ中身を ollama で返す
    if (!body.llm && body.ollama) {
        body.llm = { backend: 'ollama', ...body.ollama };
    }
    return body;
}

// 選択肢の一覧。今の設定値が一覧になくても選んだ状態で出せるように、足しておく
export function withCurrent(options: string[], ...current: string[]) {
    return [...new Set([...options, ...current])];
}

// 一覧が backend（設定モーダルで選んでいる LLM）のものか。保存する前に切り替えたときは、
// まだ前のバックエンドの一覧なので使わない（#327）
function sameBackend(options: SettingsOptions, backend: LlmBackend) {
    return (options.llm.backend ?? 'ollama') === backend;
}

// LLM（Ollama か LM Studio）に入っているモデルの名前。backend の一覧がまだなければ空
export function llmModelNames(options: SettingsOptions, backend: LlmBackend) {
    return sameBackend(options, backend) ? options.llm.models.map((m) => m.name) : [];
}

// 処理ごとのモデルが LLM に入っていないか。一覧が取れていれば入っているものと突き合わせ、
// 取れていなければサーバーが返した llm.missing を見る（#179）。backend の一覧がまだなければ分からないので false
export function isMissing(options: SettingsOptions, backend: LlmBackend, key: keyof OllamaModels, model: string) {
    if (!sameBackend(options, backend)) {
        return false;
    }
    const names = llmModelNames(options, backend);
    return names.length > 0 ? !names.includes(model) : (options.llm.missing?.includes(key) ?? false);
}

// 思考モードを使う処理（最終の要約・参考資料セット）の説明。対応していないモデルはオフで実行する（spec/files.md 5.3・spec/notes.md 9.3）
export function thinkingNote(options: SettingsOptions, model: string) {
    const thinking = options.llm.models.find((m) => m.name === model)?.thinking;
    if (thinking === false) {
        return 'このモデルは思考モードに対応していないため、オフで実行します';
    }
    if (thinking === undefined) {
        return '思考モードはオン（対応していないモデルではオフで実行します）';
    }
    return '思考モードはオン';
}
