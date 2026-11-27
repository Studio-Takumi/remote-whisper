import { type ReactNode, useEffect } from 'react';

import { HardDriveUploadIcon } from 'lucide-react';

import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { page, rememberHost, selectable, useHostsStore } from '@/features/cloud/hosts';
import { recordingMessages } from '@/features/recording/i18n';
import { useT } from '@/i18n/messages';

// オフラインのホストがあるとき、一覧を読み直す間隔（オンラインになったら「切り替える」を押せるように）
const RELOAD_HOSTS_MS = 30_000;

// ほかのホストに届かなかった音声が残っているときの知らせ（クラウド版。#227。spec/cloud.md 10.6）。
// 復旧はそのホストにつないだときで、外したホスト・ホスト不明のものはまとめて捨てられるようにする
export function UnsentElsewhereAlert() {
    const t = useT(recordingMessages);
    const elsewhere = useAppStore((s) => s.unsentElsewhere);
    const idle = useAppStore((s) => s.recordingState === 'idle');
    const discard = useAppStore((s) => s.discardUnsentElsewhere);
    const hosts = useHostsStore((s) => s.hosts);
    const load = useHostsStore((s) => s.load);

    // 一覧を読めていないときは、外したかどうか分からないので「切り替える」を出す（選ぶ画面で分かる）
    const known = elsewhere
        .filter((e) => e.host !== null && (hosts === null || hosts.some((h) => h.id === e.host)))
        .map((e) => ({ id: e.host as string, host: hosts?.find((h) => h.id === e.host) }));
    const gone = elsewhere.filter((e) => !known.some((k) => k.id === e.host)).map((e) => e.host);
    const anyOffline = known.some((k) => k.host && !selectable(k.host));

    useEffect(() => {
        if (!anyOffline || !idle) {
            return;
        }
        const timer = setInterval(() => void load(), RELOAD_HOSTS_MS);
        return () => clearInterval(timer);
    }, [anyOffline, idle, load]);

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
            {known.map(({ id, host }) => (
                <Alert
                    key={id}
                    hostId={id}
                    text={
                        host
                            ? t('unsentElsewhereAlert.unsentOnHost', { host: host.name })
                            : t('unsentElsewhereAlert.unsentOnOtherHost')
                    }
                >
                    {host && !selectable(host) ? (
                        <span
                            className='flex items-center gap-2'
                            title={t('unsentElsewhereAlert.offlineTitle', { host: host.name })}
                        >
                            <span className='text-xs text-muted-foreground'>{t('unsentElsewhereAlert.offline')}</span>
                            <Button size='sm' variant='outline' disabled>
                                {t('unsentElsewhereAlert.switch')}
                            </Button>
                        </span>
                    ) : (
                        <Button size='sm' variant='outline' onClick={() => switchTo(id)}>
                            {t('unsentElsewhereAlert.switch')}
                        </Button>
                    )}
                </Alert>
            ))}
            {gone.length > 0 && (
                <Alert hostId='gone' text={t('unsentElsewhereAlert.removedHost')}>
                    <Button size='sm' variant='outline' onClick={() => void discard(gone)}>
                        {t('common.discard')}
                    </Button>
                </Alert>
            )}
        </>
    );
}

function Alert({ hostId, text, children }: { hostId: string; text: string; children: ReactNode }) {
    return (
        <div
            role='alert'
            data-unsent-host={hostId}
            className='mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm md:flex-row md:items-center'
        >
            <HardDriveUploadIcon className='hidden size-4 shrink-0 text-amber-600 md:block dark:text-amber-400' />
            <p className='min-w-0 flex-1 break-words'>{text}</p>
            <div className='flex shrink-0 gap-2'>{children}</div>
        </div>
    );
}
