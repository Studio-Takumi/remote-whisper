import { settingsMessages } from '@/features/settings/i18n';
import type { Settings } from '@/features/settings/settings';
import { SetupGuide } from '@/features/setup/SetupGuide';
import { useSetupStatus } from '@/features/setup/useSetupStatus';
import { useT } from '@/i18n/messages';

// 設定の「セットアップ」ページ（#291）。状態を取ってから案内を出す
export function SetupPage({ settings }: { settings: Settings }) {
    const t = useT(settingsMessages);
    const { status, setStatus, refresh, error } = useSetupStatus(true);
    if (status === null) {
        return <p className='text-xs text-muted-foreground'>{error ?? t('setupPage.checking')}</p>;
    }
    return <SetupGuide status={status} onStatus={setStatus} onRefresh={refresh} settings={settings} />;
}
