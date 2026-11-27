// クラウド版で、どのホストにつないでいるかを上部に出す（#161）。押すとホストを選び直す
import { MonitorIcon } from 'lucide-react';

import { useCloudStore } from '@/features/cloud/cloud';
import { useHostsStore } from '@/features/cloud/hosts';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

export function CloudHostBadge() {
    const t = useT(cloudMessages);
    const hostId = useCloudStore((s) => s.cloud.hostId);
    const dispatch = useCloudStore((s) => s.dispatch);
    const name = useHostsStore((s) => s.hosts?.find((h) => h.id === hostId)?.name);
    if (!hostId) {
        return null;
    }
    const label = t('cloudHostBadge.label', { name: name ?? t('cloudHostBadge.fallbackName') });
    return (
        <button
            type='button'
            onClick={() => dispatch({ type: 'changeHost' })}
            title={label}
            aria-label={label}
            className='flex h-8 max-w-48 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50'
            data-cloud-host={hostId}
        >
            <MonitorIcon className='size-3.5 shrink-0' />
            {/* スマホの幅ではアイコンだけにする（ホスト名は読み上げと title で分かる。押すとホストの一覧が開く） */}
            <span className='hidden truncate md:inline'>
                {t('cloudHostBadge.connected', { name: name ?? t('cloudHostBadge.fallbackName') })}
            </span>
        </button>
    );
}
