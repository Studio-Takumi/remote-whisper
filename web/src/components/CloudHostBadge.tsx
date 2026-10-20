// クラウド版で、どのホストにつないでいるかを上部に出す（#161）。押すとホストを選び直す
import { MonitorIcon } from 'lucide-react';

import { useCloudStore } from '@/cloud';
import { useHostsStore } from '@/hosts';

export function CloudHostBadge() {
    const hostId = useCloudStore((s) => s.cloud.hostId);
    const dispatch = useCloudStore((s) => s.dispatch);
    const name = useHostsStore((s) => s.hosts?.find((h) => h.id === hostId)?.name);
    if (!hostId) {
        return null;
    }
    return (
        <button
            type='button'
            onClick={() => dispatch({ type: 'changeHost' })}
            title='押すとホストを切り替える'
            className='flex h-8 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50'
            data-cloud-host={hostId}
        >
            <MonitorIcon className='size-3.5 shrink-0' />
            <span className='truncate'>{name ?? 'ホスト'} につないでいます</span>
        </button>
    );
}
