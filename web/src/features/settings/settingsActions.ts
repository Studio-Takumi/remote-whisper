// 設定と、設定で選べる値を読む・保存する（spec/api.md 7.1）
import { toast } from 'sonner';

import { ApiError, api } from '@/api/api';
import { demoServer, isDemo } from '@/api/demo';
import { isDemoBuild } from '@/api/demoBuild';
import type { SettingsOptions } from '@/api/protocol';
import type { ActionContext } from '@/app/actionContext';
import { currentSession, needsSummaryFor } from '@/app/selectors';
import { saveDisplay, withStoredDisplay } from '@/features/settings/demoDisplay';
import { fetchOptions } from '@/features/settings/options';
import { type Settings, finalModelLabel, llmBackend, llmModels } from '@/features/settings/settings';

// 同梱したデータのデモ版（#415）は、設定も選べる値も、同梱した setting.json から答える。
// ?demo とデータなしのデモ版は、ダミーのまま
const bundledDemo = isDemoBuild && demoServer !== null;

export async function loadOptions(ctx: ActionContext) {
    const set = ctx.store.setState;
    try {
        if (bundledDemo) {
            set({ options: await api.get<SettingsOptions>('/api/settings/options') });
            return;
        }
        // デモでは、ダミーの一覧のまま
        if (isDemo) {
            return;
        }
        // Ollama につながらないときは、Ollama のモデルは空の一覧になる（今の設定値は選択肢に足して出す）
        set({ options: await fetchOptions() });
    } catch {
        // サーバーがないときはダミーの一覧のまま
    }
}

export async function loadSettings(ctx: ActionContext) {
    const set = ctx.store.setState;
    if (bundledDemo) {
        // 表示の設定は、この端末で変えたものを重ねる
        set({ settings: withStoredDisplay(await api.get<Settings>('/api/settings')), settingsLoaded: true });
        return;
    }
    if (isDemo) {
        return;
    }
    try {
        set({ settings: await api.get<Settings>('/api/settings'), settingsLoaded: true });
    } catch (e) {
        toast.error(`設定を読み込めません: ${(e as Error).message}`);
    }
}

// 簡易設定・設定モーダルのどちらからでも呼ぶ。全体設定を保存する（PATCH /api/settings）。保存できたら true
export async function changeSettings(ctx: ActionContext, next: Settings) {
    const { getState: get, setState: set } = ctx.store;
    // デモ版（#415）は、表示の設定だけをこの端末に残す。ほかの項目は、画面で変えられない
    if (isDemoBuild) {
        set({ settings: saveDisplay(get().settings, next) });
        return true;
    }
    if (isDemo) {
        set({ settings: next });
        return true;
    }
    // 読み終わる前の settings は既定値。これを送ると、サーバーの設定が既定値で上書きされる（#339）
    if (!get().settingsLoaded) {
        toast.error('設定を読み込めていないため、保存できません');
        return false;
    }
    const before = finalModelLabel(llmModels(get().settings));
    const backendBefore = llmBackend(get().settings);
    try {
        // 並び順（#173）は並び替えのときだけ送る。古い設定で、ほかの端末の並び替えを上書きしないように
        const { projectOrder: _order, ...patch } = next;
        set({ settings: await api.patch<Settings>('/api/settings', patch) });
        // LLM（Ollama か LM Studio）を切り替えたら、選べるモデルの一覧を取り直す（#327）
        const switched = llmBackend(get().settings) !== backendBefore;
        if (switched) {
            void get().loadOptions();
        }
        // 最終要約のモデルを変えたら、開いているセッションにその組の要約がなければ作り直す（#178。spec/flows.md 6.5）。
        // 録音中は作り直さない（#133）。LLM を切り替えただけでは作り直さない
        const models = llmModels(get().settings);
        const session = currentSession(get());
        if (
            !switched &&
            finalModelLabel(models) !== before &&
            session &&
            needsSummaryFor(session, models) &&
            !get().generating &&
            get().recordingState === 'idle'
        ) {
            void get().regenerateSummary(session.id);
        }
        return true;
    } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
            toast.error('録音中は、文字起こしのモデル・区切り・マイクの処理は変えられません');
        } else {
            toast.error(`設定を保存できません: ${(e as Error).message}`);
        }
        return false;
    }
}
