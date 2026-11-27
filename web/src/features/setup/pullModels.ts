// 要約のモデルの取得（セットアップの「要約のモデル」の手順。#291・#327）で出す文
import { LLM_NAMES, type LlmBackend } from '@/features/settings/settings';
import { setupMessages } from '@/features/setup/i18n';
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
        return setupMessages.t('pullModels.waitForLlm', { llm: LLM_NAMES[status.llm.backend] });
    }
    return status.recording ? setupMessages.t('pullModels.waitForRecording') : null;
}

// 取得のボタンの文。大きさが分からないもの（LM Studio の一部）があれば「以上」を付ける
export function pullButtonLabel(status: SetupStatus): string {
    const sizeGb = missingSizeGb(status);
    const sizeUnknown = missingModels(status).some((m) => m.sizeGb === null);
    if (sizeGb <= 0) {
        return setupMessages.t('pullModels.button');
    }
    return setupMessages.t(sizeUnknown ? 'pullModels.buttonAtLeast' : 'pullModels.buttonWithSize', { gb: sizeGb });
}

// 取っている途中の文。取っている先が今選んでいる LLM と違えば、先の名前を付ける
export function pullProgressText(pull: PullJob, backend: LlmBackend): string {
    const where =
        pull.backend !== backend ? setupMessages.t('pullModels.progressWhere', { llm: LLM_NAMES[pull.backend] }) : '';
    const amount =
        pull.total > 0
            ? setupMessages.t('pullModels.progressAmount', {
                  percent: pullPercent(pull),
                  done: formatGb(pull.completed),
                  total: formatGb(pull.total),
              })
            : '';
    return setupMessages.t('pullModels.progress', {
        where,
        model: pull.model,
        index: pull.index + 1,
        total: pull.models.length,
        amount,
    });
}
