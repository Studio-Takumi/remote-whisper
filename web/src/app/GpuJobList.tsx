import type { GpuJobs } from '@/api/protocol';
import { jobKindLabel, jobProgress } from '@/api/status';
import { GpuJobRow } from '@/app/GpuJobRow';
import type { JobSession } from '@/app/gpuJobs';
import { appMessages } from '@/app/i18n';
import { useT } from '@/i18n/messages';
import { formatElapsed } from '@/lib/time';

// GPU の使用率と、実行中・待っているジョブの一覧（GpuIndicator を押すと開く）
export function GpuJobList({
    jobs,
    since,
    gpu,
    sessionOf,
    onOpenSession,
}: {
    jobs: GpuJobs;
    since: number;
    gpu: { util: number; memUsedMb: number; memTotalMb: number } | null;
    sessionOf: (id: string | null) => JobSession | null;
    onOpenSession: (projectId: string, sessionId: string) => void;
}) {
    const t = useT(appMessages);
    return (
        <div className='flex flex-col gap-3'>
            <section className='flex flex-col gap-1'>
                <h3 className='font-semibold'>GPU</h3>
                {gpu ? (
                    <p className='text-xs text-muted-foreground tabular-nums'>
                        {t('gpuJobList.usage', {
                            util: gpu.util,
                            used: (gpu.memUsedMb / 1024).toFixed(1),
                            total: (gpu.memTotalMb / 1024).toFixed(1),
                        })}
                    </p>
                ) : (
                    <p className='text-xs text-muted-foreground'>{t('gpuJobList.unavailable')}</p>
                )}
            </section>
            <section className='flex flex-col gap-1'>
                <h3 className='text-xs font-semibold text-muted-foreground'>{t('gpuJobList.running')}</h3>
                {jobs.running ? (
                    <GpuJobRow
                        label={jobKindLabel(jobs.running.kind)}
                        kind={jobKindLabel(jobs.running.kind)}
                        session={sessionOf(jobs.running.session)}
                        onOpenSession={onOpenSession}
                        time={t('gpuJobList.elapsed', {
                            time: formatElapsed(Math.floor(jobs.running.runningSec + since)),
                        })}
                        progress={jobProgress(jobs.running.kind, jobs.running.progress)}
                    />
                ) : (
                    <p className='text-xs text-muted-foreground'>{t('gpuJobList.none')}</p>
                )}
            </section>
            <section className='flex flex-col gap-1'>
                <h3 className='text-xs font-semibold text-muted-foreground'>{t('gpuJobList.waiting')}</h3>
                {jobs.waiting.length > 0 ? (
                    <ol className='flex flex-col gap-1'>
                        {jobs.waiting.map((w, i) => (
                            <li key={i}>
                                <GpuJobRow
                                    label={`${i + 1}. ${jobKindLabel(w.kind)}${w.count > 1 ? ` ×${w.count}` : ''}`}
                                    kind={jobKindLabel(w.kind)}
                                    session={sessionOf(w.session)}
                                    onOpenSession={onOpenSession}
                                    time={t('gpuJobList.waited', {
                                        time: formatElapsed(Math.floor(w.waitingSec + since)),
                                    })}
                                />
                            </li>
                        ))}
                    </ol>
                ) : (
                    <p className='text-xs text-muted-foreground'>{t('gpuJobList.none')}</p>
                )}
            </section>
            <p className='text-xs text-muted-foreground'>{t('gpuJobList.note')}</p>
        </div>
    );
}
