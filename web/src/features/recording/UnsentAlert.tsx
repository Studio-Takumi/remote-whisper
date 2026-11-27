import { HardDriveUploadIcon } from 'lucide-react';

import { useSessionTitle } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { recordingMessages } from '@/features/recording/i18n';
import { useT } from '@/i18n/messages';

// 前に開いていたページで、サーバーに届かなかった音声が残っているとき（#102）。
// 送って同じセッションの続きを録音するか、捨てるかを選んでもらう
export function UnsentAlert() {
    const t = useT(recordingMessages);
    const unsent = useAppStore((s) => s.unsent);
    const idle = useAppStore((s) => s.recordingState === 'idle');
    const title = useSessionTitle(unsent?.sessionId);
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
                {unsent.seconds < 60
                    ? t('unsentAlert.leadSeconds', { n: unsent.seconds })
                    : t('unsentAlert.leadMinutes', { n: Math.round(unsent.seconds / 60) })}
                {title ? t('unsentAlert.title', { title }) : ''}
                {t('unsentAlert.tail')}
            </p>
            <div className='flex shrink-0 gap-2'>
                <Button size='sm' onClick={() => void recover()}>
                    {t('unsentAlert.send')}
                </Button>
                <Button size='sm' variant='outline' onClick={() => void discard()}>
                    {t('common.discard')}
                </Button>
            </div>
        </div>
    );
}
