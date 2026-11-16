import { MicIcon, MicOffIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { joinUnavailable } from '@/join';
import { useAppStore } from '@/store';

// ほかの端末で録音中のセッションに、この端末のマイクを音源として参加する・抜ける（#241・#356。spec/flows.md 6.16）。
// 画面の作り込み（音源の一覧など）は #357
export function JoinButton({ sessionId }: { sessionId: string }) {
    const joined = useAppStore((s) => s.joined);
    const join = useAppStore((s) => (s.watching?.sessionId === sessionId ? s.watching.join : undefined));
    const watched = useAppStore((s) => s.watching?.sessionId === sessionId);
    const recordingState = useAppStore((s) => s.recordingState);
    const joinSession = useAppStore((s) => s.joinSession);
    const leaveSession = useAppStore((s) => s.leaveSession);

    if (joined?.sessionId === sessionId) {
        const label =
            joined.state === 'joined'
                ? `音源 ${joined.source} として参加中です`
                : joined.state === 'reconnecting'
                  ? 'ホストにつなぎ直しています'
                  : '参加しています';
        return (
            <div className='mt-2 flex flex-wrap items-center gap-2'>
                <span className='inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400'>
                    <MicIcon className='size-3' />
                    {label}
                </span>
                <Button variant='outline' size='sm' onClick={leaveSession}>
                    <MicOffIcon />
                    参加をやめる
                </Button>
            </div>
        );
    }
    // 見始める返事（watching）がまだなら、出さない
    if (!watched) {
        return null;
    }
    const reason =
        recordingState !== 'idle'
            ? '録音中は参加できません'
            : joined
              ? 'ほかのセッションに参加しています'
              : joinUnavailable(join);
    return (
        <div className='mt-2 flex flex-wrap items-center gap-2'>
            <Button variant='outline' size='sm' disabled={reason !== null} onClick={() => void joinSession(sessionId)}>
                <MicIcon />
                このマイクで参加
            </Button>
            {reason && <span className='text-xs text-muted-foreground'>{reason}</span>}
        </div>
    );
}
