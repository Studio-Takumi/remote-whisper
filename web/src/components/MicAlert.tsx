import { MicOffIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { micStateMessage, useAppStore } from '@/store';

// 録音中にマイクが止まったときの、目立つ警告（#102）。上に貼り付けた場所に出すので、どこを見ていても気づける
export function MicAlert() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const micState = useAppStore((s) => s.micState);
    const reopen = useAppStore((s) => s.reopenMicrophone);

    if (!recording || micState === 'ok') {
        return null;
    }
    return (
        <div
            role='alert'
            className='flex w-full max-w-3xl items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300'
        >
            <MicOffIcon className='size-4 shrink-0 animate-pulse' />
            <p className='min-w-0 flex-1'>{micStateMessage(micState)}</p>
            {micState !== 'muted' && (
                <Button size='sm' variant='destructive' onClick={() => void reopen()}>
                    マイクを開き直す
                </Button>
            )}
        </div>
    );
}
