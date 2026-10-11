import { type RefObject, useState } from 'react';

// 録音の再生バー（spec 8）。ブラウザの audio をそのまま使う（シークは Range リクエスト。spec 7.1）
// 読み込めなかったら（保存期間を過ぎて消えた直後など）、何も出さない
export function RecordingPlayer({ src, audio }: { src: string; audio: RefObject<HTMLAudioElement | null> }) {
    const [failed, setFailed] = useState<string | null>(null);

    if (failed === src) {
        return null;
    }
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
            onError={() => setFailed(src)}
        />
    );
}
