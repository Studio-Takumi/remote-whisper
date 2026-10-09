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

    return (
        <div className='flex flex-row items-center gap-2'>
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
