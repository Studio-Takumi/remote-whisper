import { MicIcon, SparklesIcon } from 'lucide-react';

import { ContextSetSheet } from '@/components/ContextSetSheet';
import { ModelSelect } from '@/components/ModelSelect';
import { RecordingLock } from '@/components/RecordingLock';
import { ollamaModels, whisperModels } from '@/mock';
import { useAppStore } from '@/store';

// メイン画面の右上の簡易設定。全体設定をそのまま書き換える
export function TopBar() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const settings = useAppStore((s) => s.settings);
    const onChangeSettings = useAppStore((s) => s.changeSettings);

    return (
        <div className='flex flex-row items-center gap-2'>
            <RecordingLock locked={recording} className='ml-auto'>
                <div className='flex flex-row items-center gap-2'>
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
                    <ContextSetSheet />
                </div>
            </RecordingLock>
        </div>
    );
}
