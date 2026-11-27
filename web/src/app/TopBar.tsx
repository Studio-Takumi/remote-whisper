import { useLayoutEffect, useRef } from 'react';

import { ChevronRightIcon, CpuIcon } from 'lucide-react';

import { isCloud } from '@/api/endpoint';
import { GpuIndicator } from '@/app/GpuIndicator';
import { appMessages } from '@/app/i18n';
import { useAppStore } from '@/app/store';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { CloudHostBadge } from '@/features/cloud/CloudHostBadge';
import { ContextSetSheet } from '@/features/materials/ContextSetSheet';
import { RecordingLock } from '@/features/recording/RecordingLock';
import { recordingLocks } from '@/features/recording/recording';
import { llmModels } from '@/features/settings/settings';
import { useT } from '@/i18n/messages';

// メイン画面の右上の簡易設定。全体設定をそのまま書き換える
// stickySlot は、セッションのタブと再生バーを入れる置き場の受け取り口（SessionView が中に出す。#463）
export function TopBar({ stickySlot }: { stickySlot?: (el: HTMLDivElement | null) => void }) {
    const t = useT(appMessages);
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const detailModel = useAppStore((s) => llmModels(s.settings).detail);
    // 設定モーダルの「モデル」ページを開く（URL は /settings/models。戻るで閉じる）
    const openModels = () => {
        useAppStore.setState({ settingsPage: 'models', settingsOpen: true });
    };

    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        const root = document.documentElement;
        const observer = new ResizeObserver(() => root.style.setProperty('--top-bar-height', `${el.offsetHeight}px`));
        // 余白だけが変わる（セーフエリアが入る・回転する）ときも測り直す。既定の観測は中身の大きさだけ
        observer.observe(el, { box: 'border-box' });
        return () => {
            observer.disconnect();
            root.style.removeProperty('--top-bar-height');
        };
    }, []);

    // 簡易設定は「モデル」と「参考資料」だけ（#179）。モデルは設定モーダルの 1 ページにまとめた。
    // 録音中に変えられない項目（Whisper のモデル）は、そのページの中で項目ごとに押せなくする
    const modelButton = (
        <div className='flex flex-col'>
            <p className='flex items-center gap-1 px-2 text-xs whitespace-nowrap'>
                <CpuIcon className='hidden size-3 sm:block' />
                {t('topBar.model')}
            </p>
            <button
                type='button'
                onClick={openModels}
                aria-label={t('topBar.modelSettings', { model: detailModel })}
                title={t('topBar.modelSettings', { model: detailModel })}
                className='flex h-8 w-fit max-w-24 items-center justify-between gap-1.5 rounded-lg py-2 pr-2 pl-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-40 md:max-w-48 dark:bg-input/30 dark:hover:bg-input/50'
            >
                <span className='truncate'>{detailModel}</span>
                <ChevronRightIcon className='pointer-events-none size-4 shrink-0 text-muted-foreground' />
            </button>
        </div>
    );

    // 長い本文の下からでも押せるよう上に貼り付ける（#78）。本文が透けないよう背景を塗って余白まで広げ、
    // 高さは CSS 変数に出して、スクロールの位置合わせに使う（spec/ui.md 8）。
    // 開いているセッションのタブと再生バーは、下の置き場に入る（#463。上のバーと一体なので、アプリでセーフエリアの分が入っても隠れない）
    return (
        <div
            ref={ref}
            // iOS アプリの中では、ステータスバーの分だけ上に余白を足す（index.css の .rw-native）
            data-slot='top-bar'
            className='sticky top-0 z-20 -mx-4 -mt-4 flex flex-col gap-2 bg-background px-4 pt-4 pb-2'
        >
            <div className='flex flex-row items-center gap-1.5 sm:gap-2'>
                {/* スマホの幅ではサイドバーが隠れるので、開くボタンをここに出す */}
                <SidebarTrigger className='size-9 md:hidden' aria-label={t('topBar.menuOpen')} />
                <GpuIndicator />
                {/* クラウド版だけ、つないでいるホスト（#161）。録音中は切り替えない */}
                {isCloud && (
                    <RecordingLock locked={recording} message={t('topBar.hostLocked')}>
                        <CloudHostBadge />
                    </RecordingLock>
                )}
                <div className='ml-auto flex flex-row items-center gap-1.5 sm:gap-2'>
                    {modelButton}
                    <RecordingLock locked={recording} message={recordingLocks.contextSet}>
                        <ContextSetSheet />
                    </RecordingLock>
                </div>
            </div>
            {/* 空のときは出さない（セッションを開いていない画面の上のバーは前のまま） */}
            <div ref={stickySlot} className='flex flex-col items-center gap-2 empty:hidden' />
        </div>
    );
}
