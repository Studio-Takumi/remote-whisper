import type { SettingsOptions } from '@/api/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsForm } from '@/features/settings/SettingsForm';
import { settingsMessages } from '@/features/settings/i18n';
import { SETTINGS_PAGES, type Settings } from '@/features/settings/settings';
import { useT } from '@/i18n/messages';

// 全体設定のモーダル。左にカテゴリ、右に項目を並べる
export function SettingsDialog({
    open,
    onOpenChange,
    page,
    onPageChange,
    settings,
    loaded,
    onRetry,
    options,
    recording,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // 開いているページ（URL の /settings/<ページ>。#177）。知らないページなら最初のページ
    page: string;
    onPageChange: (page: string) => void;
    settings: Settings;
    // サーバーから設定を読めたか。読めるまでは既定値なので、フォームを出さず保存もさせない（#339）
    loaded: boolean;
    onRetry: () => void;
    options: SettingsOptions;
    recording: boolean;
    onSave: (settings: Settings) => void;
}) {
    const t = useT(settingsMessages);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className='flex h-[min(640px,85vh)] flex-col sm:max-w-3xl'
                onEscapeKeyDown={(e) => {
                    // ショートカットのキーを決めている間の Esc は、決めるのをやめるだけにする（ShortcutInput）
                    if (
                        document.activeElement instanceof HTMLElement &&
                        document.activeElement.dataset.shortcutCapture
                    ) {
                        e.preventDefault();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t('settingsDialog.title')}</DialogTitle>
                    <DialogDescription>
                        {recording ? t('settingsDialog.descriptionRecording') : t('settingsDialog.description')}
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに今の設定から下書きを作り直せる */}
                {loaded ? (
                    <SettingsForm
                        page={SETTINGS_PAGES.includes(page) ? page : SETTINGS_PAGES[0]}
                        onPageChange={onPageChange}
                        settings={settings}
                        options={options}
                        recording={recording}
                        onSave={(s) => {
                            onSave(s);
                            onOpenChange(false);
                        }}
                    />
                ) : (
                    <div className='flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground'>
                        <p>{t('settingsDialog.loadFailed')}</p>
                        <Button variant='outline' onClick={onRetry}>
                            {t('settingsDialog.reload')}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
