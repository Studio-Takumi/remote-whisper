import { useEffect } from 'react';

import { toast } from 'sonner';

import { alreadyNotified, rememberNotified } from '@/app/hostUpdate';
import { appMessages } from '@/app/i18n';
import { useAppStore } from '@/app/store';
import { minorVersion } from '@/app/version';

// ホストの新しい版（#472）を、版ごとに 1 回だけトーストで知らせる。設定画面のバージョンの下にはいつも出す（VersionInfo）
export function HostUpdateNotice() {
    const hostUpdate = useAppStore((s) => s.hostUpdate);

    useEffect(() => {
        if (!hostUpdate || alreadyNotified(hostUpdate.version)) {
            return;
        }
        rememberNotified(hostUpdate.version);
        toast.info(appMessages.t('hostUpdateNotice.available', { version: minorVersion(hostUpdate.version) }), {
            description: appMessages.t('hostUpdateNotice.description'),
            duration: Infinity,
            action: {
                label: appMessages.t('hostUpdateNotice.releaseNotes'),
                onClick: () => window.open(hostUpdate.url, '_blank', 'noopener'),
            },
        });
    }, [hostUpdate]);

    return null;
}
