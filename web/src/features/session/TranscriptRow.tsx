import { type Ref, memo } from 'react';

import type { TranscriptLine } from '@/api/types';
import { LineText } from '@/features/session/LineText';
import { SourceBadge } from '@/features/session/SourceBadge';

// 1行。長い文字起こし（1時間で千行ほど）でも、再生位置が変わったときに描き直すのは前後の2行だけにする
export const TranscriptRow = memo(function TranscriptRow({
    index,
    line,
    active,
    rowRef,
    onSeek,
    source,
    sourceName,
}: {
    index: number;
    line: TranscriptLine;
    active: boolean;
    rowRef?: Ref<HTMLDivElement>;
    onSeek?: (time: string) => void;
    source?: number;
    sourceName?: string | null;
}) {
    return (
        <div
            ref={rowRef}
            // 文字を選んで置き換えるときに、どの行か見分ける（#176）
            data-line-index={index}
            aria-current={active ? 'true' : undefined}
            // 目立たせても行の位置がずれないよう、余白の分を外側に出す
            className={`-mx-2 flex gap-3 rounded-md px-2 transition-colors ${active ? 'bg-primary/10 ring-1 ring-primary/30 dark:bg-primary/15 dark:ring-primary/40' : ''}`}
        >
            {onSeek ? (
                // 押すと、その位置から録音を再生する
                <button
                    className='shrink-0 self-start rounded font-mono text-xs leading-6 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'
                    aria-label={`${line.time} から再生`}
                    onClick={() => onSeek(line.time)}
                >
                    {line.time}
                </button>
            ) : (
                <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>{line.time}</span>
            )}
            {source !== undefined && <SourceBadge id={source} name={sourceName} />}
            <LineText text={line.text} />
        </div>
    );
});
