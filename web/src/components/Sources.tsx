import { MicIcon } from 'lucide-react';

import { SourceBadge } from '@/components/Transcript';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LiveSource } from '@/protocol';
import { LIVE_STATE_LABELS, type ListedSource, describeSourceSpan, sourceKindLabel, sourceTitle } from '@/sources';
import { useAppStore } from '@/store';
import type { Session } from '@/types';

const NO_SOURCES: LiveSource[] = [];

// 音源の一覧（#357。spec/ui.md 8）。文字起こしのタブの上に音源の数を出し、押すと名前・種類・参加していた時間を出す。
// 音源が 1 つのセッションでは出さない
export function SourceList({ session, sources }: { session: Session; sources: ListedSource[] }) {
    if (sources.length < 2) {
        return null;
    }
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant='outline' size='sm' title='音源の一覧'>
                    <MicIcon />
                    音源 {sources.length}
                </Button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 max-w-[calc(100vw-2rem)] p-3'>
                <p className='mb-2 text-xs text-muted-foreground'>
                    行の札は、どの音源の声として文字になったかです（話者とは別です）
                </p>
                <ul className='flex flex-col gap-2'>
                    {sources.map((s) => (
                        <li key={s.id} className='flex items-start gap-2 text-sm'>
                            <SourceBadge id={s.id} name={s.name} />
                            <div className='min-w-0'>
                                <p className='truncate'>{s.name ?? sourceTitle(s.id, null)}</p>
                                <p className='text-xs text-muted-foreground'>
                                    {sourceKindLabel(s.kind, session.uploaded === true)}・
                                    {describeSourceSpan(s, session.durationSec, session.uploaded === true)}
                                </p>
                            </div>
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
}

// 録音している端末に出す、参加している音源（名前・つながっているか）。録音の状態の表示の横に小さく出す（#357）
export function JoinedSourceChips({ sessionId }: { sessionId: string }) {
    const live = useAppStore((s) => s.liveSources[sessionId] ?? NO_SOURCES);
    const others = live.filter((s) => s.kind === 'join' && s.state !== 'left');
    if (others.length === 0) {
        return null;
    }
    return (
        <span className='ml-2 inline-flex flex-wrap items-center gap-1 align-middle'>
            {others.map((s) => (
                <span
                    key={s.id}
                    title={`${sourceTitle(s.id, s.name)}・${LIVE_STATE_LABELS[s.state]}`}
                    className='inline-flex items-center gap-1 rounded-full border px-1.5 leading-4'
                >
                    <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${s.state === 'active' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    />
                    {sourceTitle(s.id, s.name)}
                    {s.state === 'disconnected' && (
                        <span className='text-amber-700 dark:text-amber-400'>{LIVE_STATE_LABELS.disconnected}</span>
                    )}
                </span>
            ))}
        </span>
    );
}
