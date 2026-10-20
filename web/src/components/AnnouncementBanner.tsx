// 運営からのお知らせ（#164）を、画面の上に小さく出す。クラウド版だけ。閉じたら同じ id は出さない
import { useEffect, useState } from 'react';

import { XIcon } from 'lucide-react';

import { fetchAnnouncements, loadSeen, pickVisible, safeHttpsUrl, saveSeen } from '@/announcements';
import type { Announcement } from '@/announcements';
import { Button } from '@/components/ui/button';
import { isCloud } from '@/endpoint';

export function AnnouncementBanner() {
    const [list, setList] = useState<Announcement[]>([]);

    useEffect(() => {
        if (!isCloud) {
            return;
        }
        let alive = true;
        void fetchAnnouncements(isCloud).then((all) => {
            if (alive) {
                setList(pickVisible(all, loadSeen(), Date.now()));
            }
        });
        return () => {
            alive = false;
        };
    }, []);

    if (!isCloud || list.length === 0) {
        return null;
    }

    const close = (id: string) => {
        const seen = loadSeen();
        seen.add(id);
        saveSeen(seen);
        setList((l) => l.filter((a) => a.id !== id));
    };

    return (
        <div className='flex flex-col gap-1' data-testid='announcements'>
            {list.map((a) => {
                const href = safeHttpsUrl(a.url);
                return (
                    <div
                        key={a.id}
                        className='flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-sm'
                        role='status'
                    >
                        <span className='min-w-0 flex-1 truncate'>{a.title}</span>
                        {href && (
                            <a
                                href={href}
                                target='_blank'
                                rel='noopener noreferrer'
                                className='shrink-0 text-primary underline underline-offset-2'
                            >
                                詳しく見る
                            </a>
                        )}
                        <Button
                            variant='ghost'
                            size='icon'
                            className='size-6 shrink-0'
                            aria-label='閉じる'
                            onClick={() => close(a.id)}
                        >
                            <XIcon className='size-4' />
                        </Button>
                    </div>
                );
            })}
        </div>
    );
}
