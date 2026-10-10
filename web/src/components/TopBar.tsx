import { useLayoutEffect, useRef } from 'react';

import { MicIcon, SlidersHorizontalIcon, SparklesIcon } from 'lucide-react';

import { ContextSetSheet } from '@/components/ContextSetSheet';
import { ModelSelect } from '@/components/ModelSelect';
import { RecordingLock } from '@/components/RecordingLock';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ollamaModelNames, withCurrent } from '@/options';
import { useAppStore } from '@/store';

// メイン画面の右上の簡易設定。全体設定をそのまま書き換える
export function TopBar() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const settings = useAppStore((s) => s.settings);
    const options = useAppStore((s) => s.options);
    const onChangeSettings = useAppStore((s) => s.changeSettings);
    const whisperModels = withCurrent(options.whisper.models, settings.whisper.model);
    const ollamaModels = withCurrent(
        ollamaModelNames(options),
        settings.ollama.liveSummaryModel,
        settings.ollama.finalSummaryModel,
    );

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

    const selects = (
        <>
            <ModelSelect
                icon={MicIcon}
                label='文字起こし'
                value={settings.whisper.model}
                options={whisperModels}
                onChange={(model) => onChangeSettings({ ...settings, whisper: { ...settings.whisper, model } })}
            />
            <ModelSelect
                icon={SparklesIcon}
                label='要約(リアルタイム)'
                value={settings.ollama.liveSummaryModel}
                options={ollamaModels}
                onChange={(liveSummaryModel) =>
                    onChangeSettings({ ...settings, ollama: { ...settings.ollama, liveSummaryModel } })
                }
            />
            <ModelSelect
                icon={SparklesIcon}
                label='要約(最終)'
                value={settings.ollama.finalSummaryModel}
                options={ollamaModels}
                onChange={(finalSummaryModel) =>
                    onChangeSettings({ ...settings, ollama: { ...settings.ollama, finalSummaryModel } })
                }
            />
        </>
    );

    // 長い文字起こしの下の方からでも押せるよう、上に貼り付ける（#78）。本文が透けないよう背景を塗り、
    // 外側の余白（SidebarInset の p-4）まで広げて、上の隙間から本文が見えないようにする
    // 高さは CSS 変数に書き出し、その下にタブを貼り付ける（SessionView）
    return (
        <div
            ref={ref}
            className='sticky top-0 z-20 -mx-4 -mt-4 flex flex-row items-center gap-2 bg-background px-4 pt-4 pb-2'
        >
            {/* スマホの幅ではサイドバーが隠れるので、開くボタンをここに出す */}
            <SidebarTrigger className='size-9 md:hidden' aria-label='メニューを開く' />
            <RecordingLock locked={recording} className='ml-auto'>
                <div className='flex flex-row items-center gap-2'>
                    <div className='hidden flex-row items-center gap-2 md:flex'>{selects}</div>
                    {/* スマホの幅では、モデルの選択は下から出るシートにまとめる */}
                    <Sheet>
                        <SheetTrigger asChild>
                            <Button variant='ghost' size='icon' className='size-9 md:hidden' aria-label='簡易設定'>
                                <SlidersHorizontalIcon />
                            </Button>
                        </SheetTrigger>
                        <SheetContent side='bottom'>
                            <SheetHeader>
                                <SheetTitle>簡易設定</SheetTitle>
                                <SheetDescription>全体設定をそのまま書き換えます。</SheetDescription>
                            </SheetHeader>
                            <div className='flex flex-col gap-3 px-4 pb-6'>{selects}</div>
                        </SheetContent>
                    </Sheet>
                    <ContextSetSheet />
                </div>
            </RecordingLock>
        </div>
    );
}
