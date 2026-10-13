import { useEffect } from 'react';

import { CaptionsOffIcon, MicOffIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { micStateMessage, stalledMessage, useAppStore } from '@/store';

// 録音を裏に回していても気づけるよう、タブのタイトルの頭に付ける（#120）
const TITLE_MARK = '⚠ ';

// 録音中にマイクが止まったとき（#102）・音は届いているのに文字起こしが出ないとき（#120）の、目立つ警告。
// 上に貼り付けた場所に出すので、どこを見ていても気づける
export function MicAlert() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const micState = useAppStore((s) => s.micState);
    const stalled = useAppStore((s) => s.transcriptionStalled);
    const reopen = useAppStore((s) => s.reopenMicrophone);
    const warn = recording && (micState !== 'ok' || stalled);

    useEffect(() => {
        if (!warn) {
            return;
        }
        const title = document.title;
        document.title = TITLE_MARK + title;
        return () => {
            document.title = title;
        };
    }, [warn]);

    if (!warn) {
        return null;
    }
    if (micState === 'ok') {
        return (
            <div
                role='alert'
                className='flex w-full max-w-3xl items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300'
            >
                <CaptionsOffIcon className='size-4 shrink-0 animate-pulse' />
                <p className='min-w-0 flex-1'>{stalledMessage}</p>
            </div>
        );
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
