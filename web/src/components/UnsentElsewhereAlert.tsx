import { HardDriveUploadIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { page, rememberHost, useHostsStore } from '@/hosts';
import { useAppStore } from '@/store';

// ほかのホストで録音していて、届かなかった音声が残っているとき（クラウド版。#227）。
// 復旧はそのホストにつないだときにする。ここでは知らせて、そのホストに切り替えられるようにする。
// 外したホストのもの（一覧にない）は復旧できないので、捨てられるようにする
export function UnsentElsewhereAlert() {
    const elsewhere = useAppStore((s) => s.unsentElsewhere);
    const idle = useAppStore((s) => s.recordingState === 'idle');
    const discard = useAppStore((s) => s.discardUnsentElsewhere);
    const hosts = useHostsStore((s) => s.hosts);

    if (elsewhere.length === 0 || !idle) {
        return null;
    }
    // 選んだホストを覚えて読み込み直すと、そのホストに自動でつなぐ（#222 と同じ）
    const switchTo = (hostId: string) => {
        rememberHost(hostId);
        page.reload();
    };
    return (
        <>
            {elsewhere.map((e) => {
                const host = hosts?.find((h) => h.id === e.host);
                const removed = hosts !== null && !host;
                return (
                    <div
                        key={e.host}
                        role='alert'
                        data-unsent-host={e.host}
                        className='mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm md:flex-row md:items-center'
                    >
                        <HardDriveUploadIcon className='hidden size-4 shrink-0 text-amber-600 md:block dark:text-amber-400' />
                        <p className='min-w-0 flex-1 break-words'>
                            {removed ? '外したホスト' : `${host?.name ?? 'ほかのホスト'} `}に未送信の音声があります
                        </p>
                        <div className='flex shrink-0 gap-2'>
                            {removed ? (
                                <Button size='sm' variant='outline' onClick={() => void discard(e.host)}>
                                    捨てる
                                </Button>
                            ) : (
                                <Button size='sm' variant='outline' onClick={() => switchTo(e.host)}>
                                    切り替える
                                </Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </>
    );
}
