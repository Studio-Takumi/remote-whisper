import { useCallback, useState } from 'react';

import { LocateFixedIcon } from 'lucide-react';

import type { TranscriptLine } from '@/api/types';
import type { LivePartial } from '@/app/store';
import { Button } from '@/components/ui/button';
import { PartialLine } from '@/features/session/PartialLine';
import { TranscriptRow } from '@/features/session/TranscriptRow';
import { sessionMessages } from '@/features/session/i18n';
import type { Playback } from '@/features/session/playbackLine';
import { useFollowPlayback } from '@/features/session/useFollowPlayback';
import { useKeepHeight } from '@/features/session/useKeepHeight';
import { useStickToBottom } from '@/features/session/useStickToBottom';
import { useT } from '@/i18n/messages';

const NO_NAMES: Record<number, string | null> = {};

// 文字起こしの本文。確定した行（final）と、文字起こし中の区間（partial）を出す（spec/flows.md 6.2・spec/ui.md 8）
export function Transcript({
    sessionId,
    lines,
    partials,
    follow = true,
    onSeek,
    playback,
    sourceNames = NO_NAMES,
    defaultSource,
}: {
    sessionId: string;
    lines: TranscriptLine[];
    // 文字起こし中の区間。音源が 2 つ以上なら音源ごとに 1 つ（#356）
    partials: LivePartial[];
    follow?: boolean;
    // 行の時刻を押したとき（録音を再生できるときだけ渡す）
    onSeek?: (time: string) => void;
    // 録音を再生しているとき、その位置の行を目立たせて追う（#122）
    playback?: Playback | null;
    // 音源の名前（音源 ID ごと。行の音源の札の title に出す。#357）
    sourceNames?: Record<number, string | null>;
    // 音源の分からない行の音源（音源が 2 つ以上のセッションで 1。ほかの端末が参加する前の行は音源が付かないので、
    // 主の音源とみなす。spec/flows.md 6.16）。音源が 1 つのセッションでは渡さない（札を出さない）
    defaultSource?: number;
}) {
    const t = useT(sessionMessages);
    // 文字送りで伸びた分も追う（PartialLine が伸びるたびに知らせる）
    const [typed, setTyped] = useState(0);
    const onTyped = useCallback(() => setTyped((n) => n + 1), []);
    const partialKey = partials.map((p) => `${p.segment}:${p.committed}:${p.tentative}`).join('|');
    useStickToBottom(`${lines.length}:${partialKey}:${typed}`, follow);
    const { outer, inner } = useKeepHeight(sessionId, `${lines.length}:${partialKey}:${typed}`);
    const active = playback?.index ?? null;
    const { activeRow, following, followAgain } = useFollowPlayback(active, playback?.seeks ?? 0, !!playback?.playing);

    return (
        <div ref={outer}>
            {/* 行の間隔は親（TabsContent）と同じ gap-2 */}
            <div ref={inner} className='flex flex-col gap-2'>
                {lines.map((line, i) => {
                    const source = line.source ?? defaultSource;
                    return (
                        <TranscriptRow
                            key={`${line.time}-${i}`}
                            index={i}
                            line={line}
                            active={i === active}
                            rowRef={i === active ? activeRow : undefined}
                            onSeek={onSeek}
                            source={source}
                            sourceName={source !== undefined ? sourceNames[source] : undefined}
                        />
                    );
                })}
                {partials.map((partial) => {
                    const source = partial.source ?? defaultSource;
                    return (
                        <PartialLine
                            key={partial.source ?? 0}
                            partial={partial}
                            onTyped={onTyped}
                            source={source}
                            sourceName={source !== undefined ? sourceNames[source] : undefined}
                        />
                    );
                })}
            </div>
            {active !== null && !following && (
                // 自分でスクロールして再生位置から離れたとき。本文の列の中央、下のマイクのボタンより上に貼り付ける
                <div className='pointer-events-none sticky bottom-44 z-20 flex justify-center'>
                    <Button size='sm' className='pointer-events-auto rounded-full shadow-md' onClick={followAgain}>
                        <LocateFixedIcon />
                        {t('transcript.followAgain')}
                    </Button>
                </div>
            )}
        </div>
    );
}
