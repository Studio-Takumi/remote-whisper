import type { RefObject, SyntheticEvent } from 'react';

// 録音の再生バー（spec 8）。ブラウザの audio をそのまま使う（シークは Range リクエスト。spec 7.1）
// 読み込めなかったら（保存期間を過ぎて消えた直後など）onError を呼ぶ。出すかどうかは呼ぶ側が決める
// onTime は再生位置が変わったとき（再生中は 1 秒に数回）。seeked はシークしたとき（#122）
export function RecordingPlayer({
    src,
    audio,
    onError,
    onTime,
}: {
    src: string;
    audio: RefObject<HTMLAudioElement | null>;
    onError: () => void;
    onTime?: (sec: number, playing: boolean, seeked: boolean) => void;
}) {
    const report = (e: SyntheticEvent<HTMLAudioElement>, seeked = false) =>
        onTime?.(e.currentTarget.currentTime, !e.currentTarget.paused, seeked);
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
            onTimeUpdate={(e) => report(e)}
            onPlay={(e) => report(e)}
            onPause={(e) => report(e)}
            onSeeked={(e) => report(e, true)}
        />
    );
}
