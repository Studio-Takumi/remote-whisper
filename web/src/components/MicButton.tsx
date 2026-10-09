import { MicIcon, PauseIcon, PlayIcon, SquareIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { RecordingState } from '@/recording';

// sticky + mx-auto で、サイドバーの開閉に関係なくメイン領域の中央下に置く
// 大きいボタンは開始・一時停止・再開。録音を終えるのは取り返しがつかないので、右横の小さいボタンに分ける
// 小さいボタンは、マイクボタンが中央からずれないよう絶対配置にする
export function MicButton({
    state,
    onStart,
    onStop,
    onPause,
    onResume,
}: {
    state: RecordingState;
    onStart: () => void;
    onStop: () => void;
    onPause: () => void;
    onResume: () => void;
}) {
    const main = {
        idle: { onClick: onStart, label: 'クリックして録音開始', color: 'bg-blue-500', icon: <MicIcon size={64} /> },
        recording: {
            onClick: onPause,
            label: 'クリックして一時停止',
            color: 'animate-pulse bg-red-500',
            icon: <PauseIcon size={56} fill='currentColor' />,
        },
        paused: {
            onClick: onResume,
            label: 'クリックして録音再開',
            color: 'bg-green-500',
            icon: <PlayIcon size={56} fill='currentColor' />,
        },
    }[state];

    return (
        <div className='sticky bottom-8 mx-auto mt-auto shrink-0'>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        className={`flex h-32 w-32 items-center justify-center rounded-full text-white transition-colors ${main.color}`}
                        onClick={main.onClick}
                        aria-label={main.label}
                    >
                        {main.icon}
                    </button>
                </TooltipTrigger>
                <TooltipContent side='top'>{main.label}</TooltipContent>
            </Tooltip>

            {state !== 'idle' && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className='absolute top-1/2 left-full ml-4 flex size-12 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-foreground shadow-sm transition-colors hover:bg-muted'
                            onClick={onStop}
                            aria-label='クリックして録音終了'
                        >
                            <SquareIcon className='size-4' fill='currentColor' />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side='top'>クリックして録音終了</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
