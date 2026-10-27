import { useEffect, useState } from 'react';
import type { RefObject, SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    MAX_RATE,
    MIN_RATE,
    PRESET_RATES,
    RATE_STEP,
    formatRate,
    loadRate,
    normalizeRate,
    parseRate,
    saveRate,
} from '@/playbackRate';

// 録音の再生バー（spec/ui.md 8）。ブラウザの audio をそのまま使う（シークは Range リクエスト。spec/api.md 7.1）
// 読み込めなかったら（保存期間を過ぎて消えた直後など）onError を呼ぶ。出すかどうかは呼ぶ側が決める
// onTime は再生位置が変わったとき（再生中は 1 秒に数回）。seeked はシークしたとき（#122）
// 再生速度（#268）は端末ごとに覚える。audio は src が変わると作り直されて等速に戻るので、読み込みのたびにかけ直す
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
    const [rate, setRate] = useState(loadRate);
    const applyRate = (el: HTMLAudioElement) => applyPlaybackRate(el, rate);
    // 速度を変えたとき・録音を開き直したとき（key={src} で audio が作り直される）
    useEffect(() => {
        if (audio.current) {
            applyPlaybackRate(audio.current, rate);
        }
    }, [rate, src, audio]);
    const choose = (value: number) => {
        const next = normalizeRate(value);
        setRate(next);
        saveRate(next);
    };
    const report = (e: SyntheticEvent<HTMLAudioElement>, seeked = false) =>
        onTime?.(e.currentTarget.currentTime, !e.currentTarget.paused, seeked);
    return (
        <div className='flex w-full max-w-3xl items-center gap-2'>
            <audio
                key={src}
                ref={audio}
                src={src}
                controls
                preload='metadata'
                // ダークテーマでは、ブラウザが描く再生バーも暗い色にする
                className='h-9 min-w-0 flex-1 dark:scheme-dark'
                aria-label='録音を再生'
                onError={onError}
                onLoadedMetadata={(e) => applyRate(e.currentTarget)}
                onPlay={(e) => {
                    applyRate(e.currentTarget);
                    report(e);
                }}
                onTimeUpdate={(e) => report(e)}
                onPause={(e) => report(e)}
                onSeeked={(e) => report(e, true)}
            />
            <RateMenu rate={rate} onChoose={choose} />
        </div>
    );
}

// 読み込み直すと playbackRate は defaultPlaybackRate に戻るので、両方に入れる
function applyPlaybackRate(el: HTMLAudioElement, rate: number) {
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
}

// 再生速度のボタン。押すと、基本の速度と数値の入力欄を出す
function RateMenu({ rate, onChoose }: { rate: number; onChoose: (rate: number) => void }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState(String(rate));
    const commit = () => {
        const parsed = parseRate(text);
        if (parsed === null) {
            setText(String(rate));
            return;
        }
        onChoose(parsed);
        setText(String(parsed));
    };
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) {
                    setText(String(rate));
                }
            }}
        >
            <PopoverTrigger asChild>
                <Button variant='outline' size='sm' className='shrink-0 tabular-nums' aria-label='再生速度'>
                    {formatRate(rate)}
                </Button>
            </PopoverTrigger>
            <PopoverContent align='end' className='w-56'>
                <div className='grid grid-cols-3 gap-1.5'>
                    {PRESET_RATES.map((r) => (
                        <Button
                            key={r}
                            variant={r === rate ? 'default' : 'outline'}
                            size='sm'
                            className='tabular-nums'
                            aria-pressed={r === rate}
                            onClick={() => {
                                onChoose(r);
                                setText(String(r));
                            }}
                        >
                            {formatRate(r)}
                        </Button>
                    ))}
                </div>
                <label className='flex items-center gap-2 text-sm'>
                    <span className='shrink-0'>数値で指定</span>
                    <Input
                        type='number'
                        inputMode='decimal'
                        min={MIN_RATE}
                        max={MAX_RATE}
                        step={RATE_STEP}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commit();
                            }
                        }}
                        className='tabular-nums'
                    />
                </label>
                <p className='text-xs text-muted-foreground'>
                    {MIN_RATE}〜{MAX_RATE}
                </p>
            </PopoverContent>
        </Popover>
    );
}
