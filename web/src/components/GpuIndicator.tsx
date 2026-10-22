import { useEffect, useState } from 'react';

import { CpuIcon } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { GpuJobs } from '@/protocol';
import { jobKindLabel } from '@/status';
import { useAppStore } from '@/store';
import { formatElapsed } from '@/time';

// 上のバーに小さく出す GPU の状態（使用率と、GPU キューのジョブの数）。押すとジョブの一覧が開く（spec/flows.md 6.3・spec/ui.md 8）
// 録音中でも見られるよう、設定のロックの外に置く
export function GpuIndicator() {
    const jobs = useAppStore((s) => s.server.jobs);
    const jobsAt = useAppStore((s) => s.server.jobsAt);
    const gpu = useAppStore((s) => s.server.gpu);
    const projects = useAppStore((s) => s.projects);
    const [open, setOpen] = useState(false);
    const now = useNow(open);

    const waitingCount = jobs.waiting.reduce((n, w) => n + w.count, 0);
    const busy = jobs.running !== null;
    // サーバーが送った時点の秒数に、受け取ってからの時間を足す
    const since = Math.max(0, (now - jobsAt) / 1000);
    const titleOf = (id: string | null) =>
        id ? (projects.flatMap((p) => p.sessions).find((x) => x.id === id)?.title ?? id) : null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    className='flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted'
                    aria-label='GPU の状態とジョブの一覧'
                >
                    <span className='relative flex size-1.5'>
                        {busy && (
                            <span className='absolute inline-flex size-full animate-ping rounded-full bg-green-500 opacity-75' />
                        )}
                        <span
                            className={`relative inline-flex size-1.5 rounded-full ${busy ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                        />
                    </span>
                    <CpuIcon className='size-3.5' />
                    {gpu ? `${gpu.util}%` : 'GPU'}
                    {waitingCount > 0 && (
                        <span className='rounded-full bg-amber-500/15 px-1.5 text-amber-700 dark:text-amber-300'>
                            待ち {waitingCount}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 max-w-[calc(100vw-2rem)] text-sm'>
                <JobList jobs={jobs} since={since} gpu={gpu} titleOf={titleOf} />
            </PopoverContent>
        </Popover>
    );
}

function JobList({
    jobs,
    since,
    gpu,
    titleOf,
}: {
    jobs: GpuJobs;
    since: number;
    gpu: { util: number; memUsedMb: number; memTotalMb: number } | null;
    titleOf: (id: string | null) => string | null;
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
                    <JobRow
                        label={jobKindLabel[jobs.running.kind]}
                        session={titleOf(jobs.running.session)}
                        time={`${formatElapsed(Math.floor(jobs.running.runningSec + since))} 経過`}
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
                                <JobRow
                                    label={`${i + 1}. ${jobKindLabel[w.kind]}${w.count > 1 ? ` ×${w.count}` : ''}`}
                                    session={titleOf(w.session)}
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

function JobRow({ label, session, time }: { label: string; session: string | null; time: string }) {
    return (
        <div className='flex items-baseline justify-between gap-2'>
            <div className='min-w-0'>
                <p className='truncate'>{label}</p>
                {session && <p className='truncate text-xs text-muted-foreground'>{session}</p>}
            </div>
            <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{time}</span>
        </div>
    );
}

// active の間、1秒ごとに今の時刻を返す（経過時間を進めるため）
function useNow(active: boolean) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        // 開いた直後にも今の時刻にする（閉じている間は止めているので古い）
        const first = setTimeout(() => setNow(Date.now()), 0);
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [active]);
    return now;
}
