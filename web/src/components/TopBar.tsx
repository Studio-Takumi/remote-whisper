import { ContextSetSheet } from '@/components/ContextSetSheet';
import { ModelSelect } from '@/components/ModelSelect';
import { RecordingLock } from '@/components/RecordingLock';

// メイン画面の上部。左に状態、右に簡易設定
export function TopBar({ recording }: { recording: boolean }) {
    return (
        <div className='flex flex-row items-center gap-2'>
            {/* Whisper / Ollama の状態。後で WebSocket の status から出す */}
            <div className='flex items-center gap-2 text-sm'>
                <div className={`h-2 w-2 rounded-full ${recording ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                <p>{recording ? '文字起こし中' : '待機中'}</p>
            </div>
            <RecordingLock locked={recording} className='ml-auto'>
                <div className='flex flex-row items-center gap-2'>
                    <ModelSelect label='文字起こし' value='large-v3-turbo' options={['large-v3-turbo']} />
                    <ModelSelect label='要約(リアルタイム)' value='qwen3.5:4b' options={['qwen3.5:4b']} />
                    <ModelSelect label='要約(最終)' value='qwen3.5:4b' options={['qwen3.5:4b']} />
                    <ContextSetSheet />
                </div>
            </RecordingLock>
        </div>
    );
}
