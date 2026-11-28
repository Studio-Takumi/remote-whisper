import { useEffect } from 'react';

import type { LivePartial } from '@/app/store';
import { SourceBadge } from '@/features/session/SourceBadge';
import { useTypewriter } from '@/features/session/useTypewriter';
import { contentLang } from '@/i18n/contentLang';

// 文字起こし中の区間。確定した部分を文字送りで出し、追いついていない分は未確定の部分と同じく薄く出す
export function PartialLine({
    partial,
    onTyped,
    source,
    sourceName,
}: {
    partial: LivePartial;
    onTyped: () => void;
    source?: number;
    sourceName?: string | null;
}) {
    const committed = useTypewriter(partial.committed, partial.segment);
    const pending = partial.committed.slice(committed.length) + partial.tentative;
    useEffect(() => {
        onTyped();
    }, [committed, onTyped]);
    return (
        <div className='flex gap-3'>
            {/* 時刻の列と幅をそろえるため、見えない時刻を置く */}
            <span aria-hidden className='invisible shrink-0 font-mono text-xs leading-6'>
                00:00:00
            </span>
            {source !== undefined && <SourceBadge id={source} name={sourceName} />}
            <p className='leading-6' lang={contentLang(partial.committed, partial.tentative)}>
                {committed}
                <span className='text-muted-foreground/70'>{pending}</span>
            </p>
        </div>
    );
}
