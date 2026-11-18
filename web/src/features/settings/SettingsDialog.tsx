import type { SettingsOptions } from '@/api/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsForm } from '@/features/settings/SettingsForm';
import { type Settings, settingsPageOf } from '@/features/settings/settings';

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
                    <DialogTitle>設定</DialogTitle>
                    <DialogDescription>
                        {recording ? '全体設定（録音中は一部の項目は変更不可）' : '全体設定（どの端末でも共通）'}
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに今の設定から下書きを作り直せる */}
                {loaded ? (
                    <SettingsForm
                        page={settingsPageOf(page)}
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
                        <p>設定を読み込めていません</p>
                        <Button variant='outline' onClick={onRetry}>
                            再読み込み
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
