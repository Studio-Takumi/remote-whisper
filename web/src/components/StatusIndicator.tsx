import type { RecordingState } from '@/recording';

// 文字起こしの一番下に出す今の状態。Claude Code の「Pondering…」のようなイメージ
// 後で WebSocket の status（whisper / ollama の状態）から出し分ける
export function StatusIndicator({ state }: { state: RecordingState }) {
    if (state === 'idle') {
        return (
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <span className='size-2 rounded-full bg-muted-foreground/40' />
                待機中
            </div>
        );
    }

    if (state === 'paused') {
        return (
            <div className='flex items-center gap-2 text-sm'>
                <span className='size-2 rounded-full bg-amber-500' />
                一時停止中
            </div>
        );
    }

    return (
        <div className='flex items-center gap-2 text-sm'>
            <span className='relative flex size-2'>
                <span className='absolute inline-flex size-full animate-ping rounded-full bg-green-500 opacity-75' />
                <span className='relative inline-flex size-2 rounded-full bg-green-500' />
            </span>
            <span className='animate-pulse'>文字起こし中…</span>
        </div>
    );
}
