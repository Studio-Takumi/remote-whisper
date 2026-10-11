import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { isScrolledToBottom, scrollToBottom } from '@/scroll';
import type { LivePartial } from '@/store';
import type { TranscriptLine } from '@/types';

// 文字起こしの本文。確定した行（final）と、文字起こし中の区間（partial）を出す（spec 6.2・8）
export function Transcript({
    sessionId,
    lines,
    partial,
    follow = true,
    onSeek,
}: {
    sessionId: string;
    lines: TranscriptLine[];
    partial: LivePartial | null;
    follow?: boolean;
    // 行の時刻を押したとき（録音を再生できるときだけ渡す）
    onSeek?: (time: string) => void;
}) {
    const committed = useTypewriter(partial?.committed ?? '', partial?.segment ?? -1);
    // 文字送りが追いついていない分は、未確定の部分と同じく薄く出す
    const pending = (partial?.committed ?? '').slice(committed.length) + (partial?.tentative ?? '');
    useStickToBottom(`${lines.length}:${committed}:${pending}`, follow);
    const { outer, inner } = useKeepHeight(sessionId, `${lines.length}:${committed}:${pending}`);

    return (
        <div ref={outer}>
            {/* 行の間隔は親（TabsContent）と同じ gap-2 */}
            <div ref={inner} className='flex flex-col gap-2'>
                {lines.map((line, i) => (
                    <div key={`${line.time}-${i}`} className='flex gap-3'>
                        {onSeek ? (
                            // 押すと、その位置から録音を再生する
                            <button
                                className='shrink-0 self-start rounded font-mono text-xs leading-6 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'
                                aria-label={`${line.time} から再生`}
                                onClick={() => onSeek(line.time)}
                            >
                                {line.time}
                            </button>
                        ) : (
                            <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>
                                {line.time}
                            </span>
                        )}
                        <p className='leading-6'>{line.text}</p>
                    </div>
                ))}
                {partial && (
                    <div className='flex gap-3'>
                        {/* 時刻の列と幅をそろえるため、見えない時刻を置く */}
                        <span aria-hidden className='invisible shrink-0 font-mono text-xs leading-6'>
                            00:00:00
                        </span>
                        <p className='leading-6'>
                            {committed}
                            <span className='text-muted-foreground/70'>{pending}</span>
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

// 確定した文字を少しずつ出す（文字送りの演出）。key が変わったら（次の区間になったら）最初から
function useTypewriter(text: string, key: number) {
    const [shown, setShown] = useState({ key, length: 0 });
    const length = shown.key === key ? Math.min(shown.length, text.length) : 0;

    useEffect(() => {
        if (length >= text.length) {
            return;
        }
        // 残りが多いほど速く出して、次の partial が来るまでに追いつくようにする
        const timer = setTimeout(() => {
            const step = Math.max(1, Math.ceil((text.length - length) / 8));
            setShown({ key, length: Math.min(text.length, length + step) });
        }, 30);
        return () => clearTimeout(timer);
    }, [key, length, text]);

    return text.slice(0, length);
}

// 文字起こしの高さを、同じセッションのあいだは縮めない（#89）
// 未確定部分は書き換わるたびに短くなることもあり、partial の行は final の行に置き換わったり消えたりする。
// 一番下を見ているときにページが縮むと位置が詰まり、伸びてまた下へ飛ぶ、を繰り返して揺れて見えるため。
// 余る高さは partial の 1 行分ほどで、次の行で埋まる
// 外側の箱に min-height を付け、内側の箱（中身）の高さを測る。min-height を外して測ると、
// その瞬間にページが縮んでスクロールの位置が詰まってしまう
// key はセッション（変わったら測り直す）、content は中身（変わったら高さを測る）
function useKeepHeight(key: string, content: string) {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    const kept = useRef({ key, width: 0, height: 0 });

    const measure = useCallback(() => {
        if (!outer.current || !inner.current) {
            return;
        }
        // 幅が変わったら（画面を回した・ウィンドウの大きさを変えた）折り返しが変わるので、測り直す
        const width = inner.current.offsetWidth;
        if (kept.current.key !== key || kept.current.width !== width) {
            kept.current = { key, width, height: 0 };
        }
        kept.current.height = Math.max(kept.current.height, inner.current.offsetHeight);
        outer.current.style.minHeight = `${kept.current.height}px`;
    }, [key]);

    useLayoutEffect(measure, [measure, content]);

    useEffect(() => {
        if (!inner.current) {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(inner.current);
        return () => observer.disconnect();
    }, [measure]);

    return { outer, inner };
}

// 新しい行が来たらページの一番下までスクロールする。ユーザーが上のほうを見ているときは追わない
// （下のマイクのボタンは sticky だが、ページの最後に場所を取るので、一番下なら最後の行は隠れない）
// trigger は中身が変わったら動かすためのキー。ページが伸びたときだけ動かす（縮んだときに動かすと揺れて見える。#89）
// follow は出したときに追うかどうか。タブを切り替えて戻ってきたときは、前に一番下にいたときだけ追う（#78）
function useStickToBottom(trigger: string, follow: boolean) {
    const atBottom = useRef(follow);
    const lastHeight = useRef(0);

    useEffect(() => {
        const onScroll = () => {
            atBottom.current = isScrolledToBottom();
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        const height = document.documentElement.scrollHeight;
        const grew = height > lastHeight.current;
        lastHeight.current = height;
        if (trigger && grew && atBottom.current) {
            scrollToBottom();
        }
    }, [trigger]);
}
