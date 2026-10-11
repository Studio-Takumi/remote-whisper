import type { RefObject } from 'react';

// 録音の再生バー（spec 8）。ブラウザの audio をそのまま使う（シークは Range リクエスト。spec 7.1）
// 読み込めなかったら（保存期間を過ぎて消えた直後など）onError を呼ぶ。出すかどうかは呼ぶ側が決める
export function RecordingPlayer({
    src,
    audio,
    onError,
}: {
    src: string;
    audio: RefObject<HTMLAudioElement | null>;
    onError: () => void;
}) {
    return (
        <audio
            key={src}
            ref={audio}
            src={src}
            controls
            preload='metadata'
            // ダークテーマでは、ブラウザが描く再生バーも暗い色にする
            className='h-9 w-full max-w-3xl dark:scheme-dark'
            aria-label='録音を再生'
            onError={onError}
        />
    );
}
