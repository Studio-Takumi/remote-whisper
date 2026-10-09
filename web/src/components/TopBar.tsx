import { MicIcon, SparklesIcon } from 'lucide-react';

import { ModelSelect } from '@/components/ModelSelect';
import { RecordingLock } from '@/components/RecordingLock';
import { ollamaModels, whisperModels } from '@/mock';
import type { Settings } from '@/settings';

// メイン画面の右上の簡易設定。全体設定をそのまま書き換える
// 参考資料はプロジェクトごとの設定なので、中身は App から contextSheet として受け取る
export function TopBar({
    recording,
    settings,
    onChangeSettings,
    contextSheet,
}: {
    recording: boolean;
    settings: Settings;
    onChangeSettings: (settings: Settings) => void;
    contextSheet: React.ReactNode;
}) {
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
                    {contextSheet}
                </div>
            </RecordingLock>
        </div>
    );
}
