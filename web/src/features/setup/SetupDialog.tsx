import { useState } from 'react';

import { isCloud } from '@/api/endpoint';
import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { SetupGuide } from '@/features/setup/SetupGuide';
import { setupMessages } from '@/features/setup/i18n';
import { dismissGuide, guideDismissed, hasMissing, shouldAutoOpen } from '@/features/setup/setup';
import { useSetupStatus } from '@/features/setup/useSetupStatus';
import { useT } from '@/i18n/messages';

// 初めて開いたときの「はじめに」（#291。spec/ui.md 8）。セルフホスト版で、足りないものがあり、
// この端末でまだ閉じていなければ自動で出す。中身は設定の「セットアップ」と同じ
export function SetupDialog() {
    const t = useT(setupMessages);
    // クラウド版（ボタンを押せない）と、閉じたことのある端末では、状態も取りに行かない
    const [enabled] = useState(() => !isCloud && !guideDismissed());
    const [open, setOpen] = useState(false);
    const settings = useAppStore((s) => s.settings);
    // 最初に状態が届いたときに 1 回だけ決める（閉じたあとに、また開かないように）
    const { status, setStatus, refresh } = useSetupStatus(enabled, (first) => {
        const current = useAppStore.getState().settings;
        if (shouldAutoOpen(first, current, { cloud: isCloud, dismissed: guideDismissed() })) {
            setOpen(true);
        }
    });
    const missing = status !== null && hasMissing(status, settings);

    function close() {
        dismissGuide();
        setOpen(false);
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
            <DialogContent className='flex max-h-[85vh] flex-col sm:max-w-xl'>
                <DialogHeader>
                    <DialogTitle>{t('setupDialog.title')}</DialogTitle>
                    <DialogDescription>{t('setupDialog.description')}</DialogDescription>
                </DialogHeader>
                <div className='min-h-0 overflow-y-auto pr-1'>
                    {status && (
                        <SetupGuide status={status} onStatus={setStatus} onRefresh={refresh} settings={settings} />
                    )}
                </div>
                <DialogFooter>
                    <Button variant={missing ? 'outline' : 'default'} onClick={close}>
                        {missing ? t('setupDialog.later') : t('setupDialog.close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
