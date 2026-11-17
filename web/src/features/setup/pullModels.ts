// 要約のモデルの取得（セットアップの「要約のモデル」の手順。#291・#327）で出す文
import { LLM_NAMES, type LlmBackend } from '@/features/settings/settings';
import {
    type PullJob,
    type SetupStatus,
    formatGb,
    missingModels,
    missingSizeGb,
    pullPercent,
} from '@/features/setup/setup';

// 取得のボタンを押せない理由。押せるなら null
export function pullBlockedReason(status: SetupStatus): string | null {
    if (!status.llm.running) {
        return `${LLM_NAMES[status.llm.backend]} が動いてから取得できます`;
    }
    return status.recording ? '録音が終わってから取得できます' : null;
}

// 取得のボタンの文。大きさが分からないもの（LM Studio の一部）があれば「以上」を付ける
export function pullButtonLabel(status: SetupStatus): string {
    const sizeGb = missingSizeGb(status);
    const sizeUnknown = missingModels(status).some((m) => m.sizeGb === null);
    return sizeGb > 0 ? `取得（約 ${sizeGb} GB${sizeUnknown ? ' 以上' : ''}）` : '取得';
}

// 取っている途中の文。取っている先が今選んでいる LLM と違えば、先の名前を付ける
export function pullProgressText(pull: PullJob, backend: LlmBackend): string {
    const where = pull.backend !== backend ? `${LLM_NAMES[pull.backend]} で ` : '';
    const amount =
        pull.total > 0 ? `・${pullPercent(pull)}%（${formatGb(pull.completed)} / ${formatGb(pull.total)}）` : '';
    return `${where}${pull.model} を取得中（${pull.index + 1}/${pull.models.length}）${amount}`;
}
