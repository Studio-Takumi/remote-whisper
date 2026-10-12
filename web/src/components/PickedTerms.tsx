import { TagsIcon, XIcon } from 'lucide-react';

import { useAppStore } from '@/store';
import type { Session } from '@/types';

// 録音中に文字起こしから拾って、用語リストに足した語（#103）。誤った語は × で消せる（以後足さない）
export function PickedTerms({ session }: { session: Session }) {
    const reject = useAppStore((s) => s.rejectTerm);
    const terms = session.pickedTerms ?? [];

    if (terms.length === 0) {
        return null;
    }
    return (
        <div className='flex flex-wrap items-center gap-1.5 text-xs'>
            <span className='flex items-center gap-1 text-muted-foreground'>
                <TagsIcon className='size-3.5' />
                拾った用語
            </span>
            {terms.map((term) => (
                <span key={term} className='flex items-center gap-0.5 rounded-full border bg-muted/40 py-0.5 pr-1 pl-2'>
                    {term}
                    <button
                        className='rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
                        aria-label={`「${term}」を用語リストから外す`}
                        title='誤った語なら外す（このセッションでは、以後足さない）'
                        onClick={() => void reject(session.id, term)}
                    >
                        <XIcon className='size-3' />
                    </button>
                </span>
            ))}
        </div>
    );
}
