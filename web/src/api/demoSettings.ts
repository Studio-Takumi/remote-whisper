// デモ版（#415）の設定。同梱した setting.json の項目（DemoIndex.settings）を、画面の既定値に重ねて作る。
// 設定の画面・要約の既定の版（summaries/latest）・右上のモデルは、みな同じこの値を見る
import type { DemoJson } from '@/api/demoTypes';
import type { SettingsOptions } from '@/api/protocol';
import { type OllamaModels, type Settings, defaultSettings, llmModels } from '@/features/settings/settings';

function isObject(value: unknown): value is DemoJson {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// base に over を重ねる（オブジェクトは中まで。配列・値は置き換え）。over にない項目は base のまま
function merge<T>(base: T, over: unknown): T {
    if (!isObject(base) || !isObject(over)) {
        return (over === undefined || over === null ? base : over) as T;
    }
    const result: DemoJson = { ...base };
    for (const [key, value] of Object.entries(over)) {
        result[key] = key in base ? merge(base[key], value) : value;
    }
    return result as T;
}

// 同梱した設定から、画面の設定を作る。クラウド版（cloud）は見ない: ベンチの setting.json は relayUrl が空文字で、
// サーバーの検証では読めないが、デモ版は使わないので既定値のままにする
export function demoSettings(raw: DemoJson): Settings {
    const { cloud: _cloud, ...rest } = raw;
    return merge(defaultSettings, rest);
}

// 表示する要約を選ぶ、全体概要と要約詳細のモデル（設定の画面の最終要約と同じもの）
export function demoSummaryModels(raw: DemoJson): Pick<OllamaModels, 'overview' | 'detail'> {
    const { overview, detail } = llmModels(demoSettings(raw));
    return { overview, detail };
}

// 設定で選べる値（GET /api/settings/options）。モデルは Ollama のこの 5 つ
export const demoOptions: SettingsOptions = {
    whisper: {
        models: ['large-v3-turbo', 'large-v3', 'medium', 'small'],
        computeTypes: ['float16', 'int8_float16', 'int8'],
        finalTranscript: true,
    },
    llm: {
        backend: 'ollama',
        models: ['qwen3.5:4b', 'qwen3.5:2b', 'qwen3.5:0.8b', 'gemma4:e4b', 'gemma4:e2b'].map((name) => ({
            name,
            thinking: true,
        })),
    },
};
