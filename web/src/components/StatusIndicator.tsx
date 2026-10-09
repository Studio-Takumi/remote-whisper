import type { Status, Tone } from '@/status';

// 文字起こし・要約の一番下に出す今の状態。Claude Code の「Pondering…」のようなイメージ
// 文言は status.ts の transcriptStatus / summaryStatus で決める
const dotColor: Record<Tone, string> = {
    idle: 'bg-muted-foreground/40',
    active: 'bg-green-500',
    paused: 'bg-amber-500',
    warning: 'bg-amber-500',
    error: 'bg-red-500',
};

export function StatusIndicator({ status }: { status: Status }) {
    const moving = status.tone === 'active' || status.tone === 'warning';

    return (
        <div
            className={`flex items-center gap-2 text-sm ${status.tone === 'idle' ? 'text-muted-foreground' : ''} ${status.tone === 'error' ? 'text-red-600 dark:text-red-400' : ''}`}
        >
            <span className='relative flex size-2 shrink-0'>
                {moving && (
                    <span
                        className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${dotColor[status.tone]}`}
                    />
                )}
                <span className={`relative inline-flex size-2 rounded-full ${dotColor[status.tone]}`} />
            </span>
            <span className={moving ? 'animate-pulse' : ''}>{status.text}</span>
        </div>
    );
}
