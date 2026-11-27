import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';

import { api } from '@/api/api';
import { Button } from '@/components/ui/button';
import { setupMessages } from '@/features/setup/i18n';
import { PHASE_LABEL_KEYS, type SetupStatus, formatElapsed } from '@/features/setup/setup';
import { Note, Step } from '@/features/setup/steps/StepParts';
import { useT } from '@/i18n/messages';

export function WhisperXStep({
    status,
    ok,
    locked,
    act,
    onRefresh,
}: {
    status: SetupStatus;
    ok: boolean;
    locked: boolean;
    act: (call: () => Promise<SetupStatus>) => Promise<void>;
    onRefresh: () => Promise<void>;
}) {
    const t = useT(setupMessages);
    const w = status.whisperx;
    const job = w.install;
    const running = job?.state === 'running';

    let body: React.ReactNode;
    if (w.installed) {
        body = <Note>{t('common.installed')}</Note>;
    } else if (running && job) {
        body = (
            <div className='flex flex-col gap-2'>
                <Note>
                    <LoaderCircleIcon className='mr-1 inline size-3 animate-spin align-[-2px]' />
                    {t('whisperXStep.progress', {
                        phase: t(PHASE_LABEL_KEYS[job.phase]),
                        package: job.package ? t('whisperXStep.package', { name: job.package }) : '',
                        elapsed: formatElapsed(job.elapsedSec),
                    })}
                </Note>
                {job.phase !== 'rollingBack' && (
                    <div>
                        <Button
                            variant='outline'
                            size='sm'
                            disabled={locked}
                            onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/whisperx'))}
                        >
                            {t('common.cancel')}
                        </Button>
                    </div>
                )}
            </div>
        );
    } else if (w.installable) {
        body = (
            <>
                {job?.state === 'failed' &&
                    (job.rollbackFailed ? (
                        <Note warn>{t('whisperXStep.rollbackFailed')}</Note>
                    ) : (
                        <Note warn>{t('whisperXStep.rolledBack')}</Note>
                    ))}
                {job?.state === 'cancelled' && <Note>{t('whisperXStep.cancelled')}</Note>}
                <Note>
                    {t('whisperXStep.cost', {
                        download: w.downloadGb,
                        disk: w.diskGb,
                        min: w.minutes[0],
                        max: w.minutes[1],
                    })}
                </Note>
                <div className='flex flex-wrap items-center gap-2'>
                    <Button
                        size='sm'
                        disabled={locked || status.recording}
                        onClick={() => void act(() => api.post<SetupStatus>('/api/setup/whisperx'))}
                    >
                        <DownloadIcon />
                        {t('whisperXStep.install')}
                    </Button>
                    {status.recording && <Note warn>{t('whisperXStep.waitForRecording')}</Note>}
                </div>
            </>
        );
    } else if (status.runtime !== 'dev') {
        // 固定した依存の一覧を同梱していない古い配布版: 画面からは入れない
        body = <Note warn>{t('whisperXStep.notInstallable')}</Note>;
    } else {
        // 開発の環境（uv）: 案内だけ
        body = (
            <>
                <Note>{t('whisperXStep.devCommand')}</Note>
                <code className='w-fit rounded bg-muted px-2 py-1 font-mono text-xs'>
                    {w.command ?? 'uv sync --extra final'}
                </code>
                <div>
                    <Button variant='outline' size='sm' onClick={() => void onRefresh()}>
                        <RefreshCwIcon />
                        {t('common.recheck')}
                    </Button>
                </div>
            </>
        );
    }
    return (
        <Step title='WhisperX' purpose={t('whisperXStep.purpose')} ok={ok || w.installed}>
            {body}
        </Step>
    );
}
