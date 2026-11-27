import { MicIcon } from 'lucide-react';

import type { LiveSource } from '@/api/protocol';
import type { Session } from '@/api/types';
import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SourceBadge } from '@/features/session/SourceBadge';
import { sessionMessages } from '@/features/session/i18n';
import {
    type ListedSource,
    describeSourceSpan,
    liveStateLabel,
    sourceKindLabel,
    sourceTitle,
} from '@/features/session/sources';
import { useT } from '@/i18n/messages';

const NO_SOURCES: LiveSource[] = [];

// 音源の一覧（#357。spec/ui.md 8）。文字起こしのタブの上に音源の数を出し、押すと名前・種類・参加していた時間を出す。
// 音源が 1 つのセッションでは出さない
export function SourceList({ session, sources }: { session: Session; sources: ListedSource[] }) {
    const t = useT(sessionMessages);
    if (sources.length < 2) {
        return null;
    }
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant='outline' size='sm' title={t('sourceList.list')}>
                    <MicIcon />
                    {/* 行の札（「音源 2」は音源 ID）と取り違えないよう、数は「つ」で数える */}
                    {t('sourceList.count', { n: sources.length })}
                </Button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 max-w-[calc(100vw-2rem)] p-3'>
                <p className='mb-2 text-xs text-muted-foreground'>{t('sourceList.badgeNote')}</p>
                <ul className='flex flex-col gap-2'>
                    {sources.map((s) => (
                        <li key={s.id} className='flex items-start gap-2 text-sm'>
                            <SourceBadge id={s.id} name={s.name} />
                            <div className='min-w-0'>
                                {/* 名前がなければ（主の音源など）種類を名前の代わりにする（「音源 1」を 2 回並べない） */}
                                <p className='truncate'>
                                    {s.name ?? sourceKindLabel(s.kind, session.uploaded === true)}
                                </p>
                                <p className='text-xs text-muted-foreground'>
                                    {s.name &&
                                        t('sourceList.kindPrefix', {
                                            kind: sourceKindLabel(s.kind, session.uploaded === true),
                                        })}
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
    const t = useT(sessionMessages);
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
                    title={t('sourceList.titleWithState', {
                        source: sourceTitle(s.id, s.name),
                        state: liveStateLabel(s.state),
                    })}
                    className='inline-flex items-center gap-1 rounded-full border px-1.5 leading-4'
                >
                    <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${s.state === 'active' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    />
                    {sourceTitle(s.id, s.name)}
                    {s.state === 'disconnected' && (
                        <span className='text-amber-700 dark:text-amber-400'>{liveStateLabel('disconnected')}</span>
                    )}
                </span>
            ))}
        </span>
    );
}
