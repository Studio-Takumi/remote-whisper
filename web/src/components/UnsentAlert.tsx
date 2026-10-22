import { HardDriveUploadIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';

// 前に開いていたページで、サーバーに届かなかった音声が残っているとき（#102）。
// 送って同じセッションの続きを録音するか、捨てるかを選んでもらう
export function UnsentAlert() {
    const unsent = useAppStore((s) => s.unsent);
    const idle = useAppStore((s) => s.recordingState === 'idle');
    const title = useAppStore(
        (s) => s.projects.flatMap((p) => p.sessions).find((x) => x.id === s.unsent?.sessionId)?.title,
    );
    const recover = useAppStore((s) => s.recoverUnsent);
    const discard = useAppStore((s) => s.discardUnsent);

    if (!unsent || !idle) {
        return null;
    }
    return (
        <div
            role='alert'
            className='mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm md:flex-row md:items-center'
        >
            <HardDriveUploadIcon className='hidden size-4 shrink-0 text-amber-600 md:block dark:text-amber-400' />
            <p className='min-w-0 flex-1'>
                前にページを開いていたとき、ホストに届かなかった録音が
                {unsent.seconds < 60 ? ` ${unsent.seconds} 秒` : ` 約 ${Math.round(unsent.seconds / 60)} 分`}あります
                {title ? `（${title}）` : ''}。送って、同じセッションの続きを録音できます
            </p>
            <div className='flex shrink-0 gap-2'>
                <Button size='sm' onClick={() => void recover()}>
                    送って続きを録音
                </Button>
                <Button size='sm' variant='outline' onClick={() => void discard()}>
                    捨てる
                </Button>
            </div>
        </div>
    );
}
