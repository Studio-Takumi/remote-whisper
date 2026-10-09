import { MicIcon, SparklesIcon } from 'lucide-react';

import { ContextSetSheet } from '@/components/ContextSetSheet';
import { ModelSelect } from '@/components/ModelSelect';
import { RecordingLock } from '@/components/RecordingLock';
import { ollamaModels, whisperModels } from '@/mock';
import type { Settings } from '@/settings';

// メイン画面の上部。左に状態、右に簡易設定。簡易設定は全体設定をそのまま書き換える
export function TopBar({
    recording,
    settings,
    onChangeSettings,
}: {
    recording: boolean;
    settings: Settings;
    onChangeSettings: (settings: Settings) => void;
}) {
    return (
        <div className='flex flex-row items-center gap-2'>
            {/* Whisper / Ollama の状態。後で WebSocket の status から出す */}
            <div className='flex items-center gap-2 text-sm'>
                <div className={`h-2 w-2 rounded-full ${recording ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                <p>{recording ? '文字起こし中' : '待機中'}</p>
            </div>
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
