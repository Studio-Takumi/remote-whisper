import { DownloadIcon } from 'lucide-react';

import { api } from '@/api/api';
import { serverErrorText } from '@/api/serverErrors/serverErrors';
import { Button } from '@/components/ui/button';
import { LLM_NAMES, recommendedLmStudioModels } from '@/features/settings/settings';
import { setupMessages } from '@/features/setup/i18n';
import { pullBlockedReason, pullButtonLabel, pullProgressText } from '@/features/setup/pullModels';
import { type SetupStatus, missingModels, pullPercent } from '@/features/setup/setup';
import { Note, ProgressBar, Step } from '@/features/setup/steps/StepParts';
import { useT } from '@/i18n/messages';
import { formatDecimal } from '@/lib/format';

export function ModelsStep({
    status,
    ok,
    locked,
    act,
}: {
    status: SetupStatus;
    ok: boolean;
    locked: boolean;
    act: (call: () => Promise<SetupStatus>) => Promise<void>;
}) {
    const t = useT(setupMessages);
    const llm = status.llm;
    const name = LLM_NAMES[llm.backend];
    const pull = llm.pull;
    const pulling = pull?.state === 'running';
    const missing = missingModels(status);
    const reason = pullBlockedReason(status);

    return (
        <Step title={t('modelsStep.title')} purpose={t('modelsStep.purpose', { llm: name })} ok={ok}>
            {llm.backend === 'lmstudio' && (
                <Note>{t('modelsStep.lmStudioNote', { model: recommendedLmStudioModels.liveSummary })}</Note>
            )}
            <ul className='flex flex-col gap-1'>
                {llm.models.map((m) => (
                    <li key={m.name} className='flex items-center justify-between gap-2 text-xs'>
                        <span className='font-mono'>{m.name}</span>
                        <span className='flex shrink-0 items-center gap-3 whitespace-nowrap text-muted-foreground'>
                            {m.sizeGb !== null && <span>{formatDecimal(m.sizeGb, 1)} GB</span>}
                            <span
                                className={
                                    m.installed
                                        ? 'min-w-[6.5em] text-right text-emerald-700 dark:text-emerald-400'
                                        : 'min-w-[6.5em] text-right text-amber-700 dark:text-amber-400'
                                }
                            >
                                {m.installed ? t('common.installed') : t('modelsStep.notInstalled')}
                            </span>
                        </span>
                    </li>
                ))}
            </ul>
            {pulling && pull ? (
                <div className='flex flex-col gap-1'>
                    <Note>{pullProgressText(pull, llm.backend)}</Note>
                    <ProgressBar
                        percent={pullPercent(pull)}
                        label={t('modelsStep.downloading', { model: pull.model })}
                    />
                    {/* 取っている途中に切り替えたときも、始めたほうで決める（LM Studio は止められない） */}
                    {pull.backend !== 'lmstudio' ? (
                        <div>
                            <Button
                                variant='outline'
                                size='sm'
                                disabled={locked}
                                onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/llm/pull'))}
                            >
                                {t('common.cancel')}
                            </Button>
                        </div>
                    ) : (
                        // LM Studio には取得を止める API がない（#327）
                        <Note>{t('modelsStep.stopInLmStudio')}</Note>
                    )}
                </div>
            ) : (
                <>
                    {pull?.state === 'failed' && (
                        <Note warn>
                            {pull.error == null
                                ? t('modelsStep.downloadFailed')
                                : serverErrorText(pull.errorCode, pull.errorParams, pull.error)}
                        </Note>
                    )}
                    {pull?.state === 'cancelled' && <Note>{t('modelsStep.downloadCancelled')}</Note>}
                    {missing.length > 0 && (
                        <div className='flex flex-wrap items-center gap-2'>
                            <Button
                                size='sm'
                                disabled={locked || reason !== null}
                                onClick={() =>
                                    void act(() =>
                                        api.post<SetupStatus>('/api/setup/llm/pull', {
                                            models: missing.map((m) => m.name),
                                        }),
                                    )
                                }
                            >
                                <DownloadIcon />
                                {pullButtonLabel(status)}
                            </Button>
                            {reason && <Note warn>{reason}</Note>}
                        </div>
                    )}
                </>
            )}
        </Step>
    );
}
