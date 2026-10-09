import { MicIcon, SquareIcon } from 'lucide-react';

// sticky + mx-auto で、サイドバーの開閉に関係なくメイン領域の中央下に置く
export function MicButton({ recording, onToggle }: { recording: boolean; onToggle: () => void }) {
    return (
        <button
            className={`sticky bottom-8 mx-auto mt-auto flex h-32 w-32 shrink-0 items-center justify-center rounded-full text-white transition-colors ${recording ? 'animate-pulse bg-red-500' : 'bg-blue-500'}`}
            onClick={onToggle}
            aria-label={recording ? '録音を止める' : '録音を始める'}
        >
            {recording ? <SquareIcon size={48} fill='currentColor' /> : <MicIcon size={64} />}
        </button>
    );
}
