import { useEffect, useRef, useState } from 'react';

import type { TranscriptLine } from '@/mock';
import type { LivePartial } from '@/store';

// 文字起こしの本文。確定した行（final）と、文字起こし中の区間（partial）を出す（spec 6.2・8）
export function Transcript({ lines, partial }: { lines: TranscriptLine[]; partial: LivePartial | null }) {
    const committed = useTypewriter(partial?.committed ?? '', partial?.segment ?? -1);
    // 文字送りが追いついていない分は、未確定の部分と同じく薄く出す
    const pending = (partial?.committed ?? '').slice(committed.length) + (partial?.tentative ?? '');
    const bottomRef = useStickToBottom([lines.length, committed, pending]);

    return (
        <>
            {lines.map((line, i) => (
                <div key={`${line.time}-${i}`} className='flex gap-3'>
                    <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>{line.time}</span>
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
            {/* 下のマイクのボタン（sticky）に隠れないよう、その高さぶん余白をとって止める */}
            <div ref={bottomRef} className='scroll-mb-64' />
        </>
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

// 新しい行が来たら下までスクロールする。ユーザーが上のほうを見ているときは追わない
function useStickToBottom(deps: unknown[]) {
    const ref = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);

    useEffect(() => {
        const onScroll = () => {
            const el = document.scrollingElement ?? document.documentElement;
            atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 160;
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        if (atBottom.current) {
            ref.current?.scrollIntoView({ block: 'end' });
        }
        // 呼ぶ側が渡した deps の中身が変わったときだけ動かす
    }, deps);

    return ref;
}
