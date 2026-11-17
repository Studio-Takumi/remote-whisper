import type { GpuJobs } from '@/api/protocol';
import { jobKindLabel, jobProgress } from '@/api/status';
import { GpuJobRow, type JobSession } from '@/app/GpuJobRow';
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
    return (
        <div className='flex flex-col gap-3'>
            <section className='flex flex-col gap-1'>
                <h3 className='font-semibold'>GPU</h3>
                {gpu ? (
                    <p className='text-xs text-muted-foreground tabular-nums'>
                        使用率 {gpu.util}% ・ VRAM {(gpu.memUsedMb / 1024).toFixed(1)} /{' '}
                        {(gpu.memTotalMb / 1024).toFixed(1)} GB
                    </p>
                ) : (
                    <p className='text-xs text-muted-foreground'>使用率は取れません（NVIDIA の GPU がないなど）</p>
                )}
            </section>
            <section className='flex flex-col gap-1'>
                <h3 className='text-xs font-semibold text-muted-foreground'>実行中</h3>
                {jobs.running ? (
                    <GpuJobRow
                        label={jobKindLabel[jobs.running.kind]}
                        kind={jobKindLabel[jobs.running.kind]}
                        session={sessionOf(jobs.running.session)}
                        onOpenSession={onOpenSession}
                        time={`${formatElapsed(Math.floor(jobs.running.runningSec + since))} 経過`}
                        progress={jobProgress(jobs.running.kind, jobs.running.progress)}
                    />
                ) : (
                    <p className='text-xs text-muted-foreground'>なし</p>
                )}
            </section>
            <section className='flex flex-col gap-1'>
                <h3 className='text-xs font-semibold text-muted-foreground'>待っている（実行する順）</h3>
                {jobs.waiting.length > 0 ? (
                    <ol className='flex flex-col gap-1'>
                        {jobs.waiting.map((w, i) => (
                            <li key={i}>
                                <GpuJobRow
                                    label={`${i + 1}. ${jobKindLabel[w.kind]}${w.count > 1 ? ` ×${w.count}` : ''}`}
                                    kind={jobKindLabel[w.kind]}
                                    session={sessionOf(w.session)}
                                    onOpenSession={onOpenSession}
                                    time={`${formatElapsed(Math.floor(w.waitingSec + since))} 待ち`}
                                />
                            </li>
                        ))}
                    </ol>
                ) : (
                    <p className='text-xs text-muted-foreground'>なし</p>
                )}
            </section>
            <p className='text-xs text-muted-foreground'>
                GPU は 1 つずつ順に使います。要約を作っている間は、文字起こしが待たされます
            </p>
        </div>
    );
}
