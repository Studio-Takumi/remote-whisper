import { toast } from 'sonner';

import { setupMessages } from '@/features/setup/i18n';
import { type SetupStatus, type WhisperFlags, missingSteps, needsCudaEdition } from '@/features/setup/setup';
import { GpuStep } from '@/features/setup/steps/GpuStep';
import { LlmStep } from '@/features/setup/steps/LlmStep';
import { ModelsStep } from '@/features/setup/steps/ModelsStep';
import { TokenStep } from '@/features/setup/steps/TokenStep';
import { WhisperXStep } from '@/features/setup/steps/WhisperXStep';
import { useT } from '@/i18n/messages';

// 足りないものを順に並べる（設定の「セットアップ」と、初回の「はじめに」で同じもの）
export function SetupGuide({
    status,
    onStatus,
    onRefresh,
    settings,
}: {
    status: SetupStatus;
    onStatus: (status: SetupStatus) => void;
    onRefresh: () => Promise<void>;
    settings: WhisperFlags;
}) {
    const t = useT(setupMessages);
    const missing = missingSteps(status, settings);
    // クラウド版（トンネル）からは見るだけ
    const locked = status.remote;

    async function act(call: () => Promise<SetupStatus>) {
        try {
            onStatus(await call());
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('setupGuide.failed'));
            void onRefresh();
        }
    }

    return (
        <div className='flex flex-col gap-3'>
            {locked ? (
                <p className='rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300'>
                    {t('setupGuide.cloudReadOnly')}
                </p>
            ) : (
                <p className='text-xs text-muted-foreground'>{t('setupGuide.skippable')}</p>
            )}
            {status.gpu === 'none' && <GpuStep />}
            {needsCudaEdition(status) && <GpuStep wrongEdition />}
            <LlmStep status={status} ok={!missing.llm} onRefresh={onRefresh} />
            <ModelsStep status={status} ok={!missing.models} locked={locked} act={act} />
            <WhisperXStep status={status} ok={!missing.whisperx} locked={locked} act={act} onRefresh={onRefresh} />
            <TokenStep status={status} ok={status.hfToken.source !== null} locked={locked} act={act} />
        </div>
    );
}
