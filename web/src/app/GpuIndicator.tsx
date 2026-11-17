import { useState } from 'react';

import { CpuIcon } from 'lucide-react';

import { GpuJobList } from '@/app/GpuJobList';
import { findJobSession, gpuTriggerLabel, waitingCount } from '@/app/gpuJobs';
import { useProjectList } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';
import { useNow } from '@/app/useNow';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// 上のバーに小さく出す GPU の状態（使用率と、GPU キューのジョブの数）。押すとジョブの一覧が開く（spec/flows.md 6.3・spec/ui.md 8）
// 録音中でも見られるよう、設定のロックの外に置く
export function GpuIndicator() {
    const jobs = useAppStore((s) => s.server.jobs);
    const jobsAt = useAppStore((s) => s.server.jobsAt);
    const gpu = useAppStore((s) => s.server.gpu);
    const projects = useProjectList();
    const selectSession = useAppStore((s) => s.selectSession);
    const [open, setOpen] = useState(false);
    const now = useNow(open);

    const waiting = waitingCount(jobs);
    const busy = jobs.running !== null;
    // サーバーが送った時点の秒数に、受け取ってからの時間を足す
    const since = Math.max(0, (now - jobsAt) / 1000);
    const sessionOf = (id: string | null) => findJobSession(projects, id);
    const triggerLabel = gpuTriggerLabel(gpu, waiting);
    const openSession = (projectId: string, sessionId: string) => {
        selectSession(projectId, sessionId);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    className='relative flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted'
                    aria-label={triggerLabel}
                    title={triggerLabel}
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
                    {/* スマホの幅では、点とアイコンだけにする（使用率とキュー数は一覧と読み上げで分かる） */}
                    <span className='hidden md:inline'>{gpu ? `${gpu.util}%` : 'GPU'}</span>
                    {waiting > 0 && (
                        <>
                            <span className='hidden rounded-full bg-amber-500/15 px-1.5 text-amber-700 md:inline dark:text-amber-300'>
                                待ち {waiting}
                            </span>
                            <span
                                aria-hidden
                                className='absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-medium text-amber-950 md:hidden'
                            >
                                {waiting > 99 ? '99+' : waiting}
                            </span>
                        </>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 max-w-[calc(100vw-2rem)] text-sm'>
                <GpuJobList jobs={jobs} since={since} gpu={gpu} sessionOf={sessionOf} onOpenSession={openSession} />
            </PopoverContent>
        </Popover>
    );
}
