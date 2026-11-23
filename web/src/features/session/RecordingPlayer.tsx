import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject, SyntheticEvent } from 'react';

import { appAuthActive, appMediaUrl } from '@/api/appAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
    MAX_RATE,
    MIN_RATE,
    PRESET_RATES,
    commitRate,
    formatRate,
    loadRate,
    normalizeRate,
    saveRate,
} from '@/features/session/playbackRate';
import { type SessionSource, sourceKindLabel, sourceLabel, sourceTitle } from '@/features/session/sources';

// <audio> はヘッダーを付けられないので、アプリの中のクラウド版では、チケットを付けた URL にしてから読む（#441）。
// ほかは src のまま（チケットを待つ間だけ null）
function usePlayableSrc(src: string): string | null {
    const [ticketed, setTicketed] = useState<{ src: string; url: string } | null>(null);
    useEffect(() => {
        if (!appAuthActive) {
            return;
        }
        let alive = true;
        void appMediaUrl(src).then((url) => {
            if (alive) {
                setTicketed({ src, url });
            }
        });
        return () => {
            alive = false;
        };
    }, [src]);
    if (!appAuthActive) {
        return src;
    }
    return ticketed?.src === src ? ticketed.url : null;
}

// 録音の再生バー（spec/ui.md 8・spec/api.md 7.1）。読み込めなかったら onError を呼ぶ（出すかどうかは呼ぶ側が決める）。
// 再生速度（#268）は端末ごとに覚え、src が変わると等速に戻るので読み込みのたびにかけ直す（spec/ui.md 8）。onLoaded は音源の切り替え（#371）用
export function RecordingPlayer({
    src,
    audio,
    onError,
    onTime,
    onLoaded,
    onUnmount,
    children,
}: {
    src: string;
    audio: RefObject<HTMLAudioElement | null>;
    onError: () => void;
    onTime?: (sec: number, playing: boolean, seeked: boolean) => void;
    onLoaded?: (el: HTMLAudioElement) => void;
    // 再生バーが消えた（画面の回転で置き場が変わって作り直されたときなど）。audio は pause を報せずに消えるので、呼ぶ側が再生の状態を畳む
    onUnmount?: () => void;
    children?: ReactNode;
}) {
    const [rate, setRate] = useState(loadRate);
    const playable = usePlayableSrc(src);
    const unmount = useRef(onUnmount);
    useEffect(() => {
        unmount.current = onUnmount;
    });
    useEffect(() => () => unmount.current?.(), []);
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
        <div className={`flex w-full max-w-3xl items-center gap-2 ${children ? 'flex-wrap' : ''}`}>
            <audio
                key={src}
                ref={audio}
                src={playable ?? undefined}
                controls
                preload='metadata'
                // ダークテーマでは、ブラウザが描く再生バーも暗い色にする
                className={`h-9 flex-1 dark:scheme-dark ${children ? 'min-w-44 sm:min-w-64' : 'min-w-0'}`}
                aria-label='録音を再生'
                onError={onError}
                onLoadedMetadata={(e) => {
                    applyRate(e.currentTarget);
                    onLoaded?.(e.currentTarget);
                }}
                onPlay={(e) => {
                    applyRate(e.currentTarget);
                    report(e);
                }}
                onTimeUpdate={(e) => report(e)}
                onPause={(e) => report(e)}
                onSeeked={(e) => report(e, true)}
            />
            {children ? (
                // 音源のメニューがあるときは、狭い画面で再生バーのシークが消えないよう、次の行に回す（#371）
                <div className='ml-auto flex shrink-0 items-center gap-2'>
                    {children}
                    <RateMenu rate={rate} onChoose={choose} />
                </div>
            ) : (
                <RateMenu rate={rate} onChoose={choose} />
            )}
        </div>
    );
}

// 再生する音源のメニュー（#371。spec/ui.md 8）。録音ファイルの残っている音源だけ並べる。
// ボタンには「音源 2」だけを出し（スマホの幅で再生バーを狭めない）、メニューには名前も出す
export function PlaybackSourceSelect({
    sources,
    value,
    onChange,
    uploaded,
}: {
    sources: SessionSource[];
    value: number;
    onChange: (id: number) => void;
    uploaded: boolean;
}) {
    const current = sources.find((s) => s.id === value);
    return (
        <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
            <SelectTrigger
                size='sm'
                className='shrink-0 tabular-nums'
                aria-label='再生する音源'
                title={current ? sourceTitle(current.id, current.name) : undefined}
            >
                <SelectValue>{sourceLabel(value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {sources.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                        {sourceTitle(s.id, s.name ?? sourceKindLabel(s.kind, uploaded))}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
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
        const next = commitRate(text, rate);
        onChoose(next);
        setText(String(next));
    };
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) {
                    setText(String(rate));
                } else {
                    // 外側のタップで閉じると blur が来ないことがあるので、閉じるときにも確定する
                    commit();
                }
            }}
        >
            <PopoverTrigger asChild>
                <Button
                    variant='outline'
                    size='sm'
                    className='shrink-0 tabular-nums'
                    aria-label={`再生速度（${formatRate(rate)}）`}
                >
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
                        type='text'
                        inputMode='decimal'
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
