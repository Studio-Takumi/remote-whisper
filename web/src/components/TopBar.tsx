import { useLayoutEffect, useRef } from 'react';

import { ChevronRightIcon, CpuIcon } from 'lucide-react';

import { CloudHostBadge } from '@/components/CloudHostBadge';
import { ContextSetSheet } from '@/components/ContextSetSheet';
import { GpuIndicator } from '@/components/GpuIndicator';
import { RecordingLock } from '@/components/RecordingLock';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { isCloud } from '@/endpoint';
import { recordingLocks } from '@/recording';
import { useAppStore } from '@/store';

// メイン画面の右上の簡易設定。全体設定をそのまま書き換える
export function TopBar() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const detailModel = useAppStore((s) => s.settings.ollama.models.detail);
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
        observer.observe(el);
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
                モデル
            </p>
            <button
                type='button'
                onClick={openModels}
                aria-label={`モデルの設定を開く（${detailModel}）`}
                title={`モデルの設定を開く（${detailModel}）`}
                className='flex h-8 w-fit max-w-24 items-center justify-between gap-1.5 rounded-lg py-2 pr-2 pl-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-40 md:max-w-48 dark:bg-input/30 dark:hover:bg-input/50'
            >
                <span className='truncate'>{detailModel}</span>
                <ChevronRightIcon className='pointer-events-none size-4 shrink-0 text-muted-foreground' />
            </button>
        </div>
    );

    // 長い文字起こしの下の方からでも押せるよう、上に貼り付ける（#78）。本文が透けないよう背景を塗り、
    // 外側の余白（SidebarInset の p-4）まで広げて、上の隙間から本文が見えないようにする
    // 高さは CSS 変数に書き出し、その下にタブを貼り付ける（SessionView）
    return (
        <div
            ref={ref}
            className='sticky top-0 z-20 -mx-4 -mt-4 flex flex-row items-center gap-1.5 bg-background px-4 pt-4 pb-2 sm:gap-2'
        >
            {/* スマホの幅ではサイドバーが隠れるので、開くボタンをここに出す */}
            <SidebarTrigger className='size-9 md:hidden' aria-label='メニューを開く' />
            <GpuIndicator />
            {/* クラウド版だけ、つないでいるホスト（#161）。録音中は切り替えない */}
            {isCloud && (
                <RecordingLock locked={recording} message='録音中はホストを切り替えられません'>
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
    );
}
