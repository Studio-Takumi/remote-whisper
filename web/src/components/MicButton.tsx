import { MicIcon, SquareIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// sticky + mx-auto で、サイドバーの開閉に関係なくメイン領域の中央下に置く
export function MicButton({ recording, onToggle }: { recording: boolean; onToggle: () => void }) {
    const label = recording ? 'クリックして録音終了' : 'クリックして録音開始';

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    className={`sticky bottom-8 mx-auto mt-auto flex h-32 w-32 shrink-0 items-center justify-center rounded-full text-white transition-colors ${recording ? 'animate-pulse bg-red-500' : 'bg-blue-500'}`}
                    onClick={onToggle}
                    aria-label={label}
                >
                    {recording ? <SquareIcon size={48} fill='currentColor' /> : <MicIcon size={64} />}
                </button>
            </TooltipTrigger>
            <TooltipContent side='top'>{label}</TooltipContent>
        </Tooltip>
    );
}
