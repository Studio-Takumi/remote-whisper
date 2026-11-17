import { useEffect, useRef } from 'react';

import { isScrolledToBottom, scrollToBottom } from '@/lib/scroll';

// 新しい行が来たらページの一番下までスクロールする（上のほうを見ているときは追わない。spec/ui.md 8）。
// trigger はページが伸びたときだけ動かす（縮んだときは揺れる。#89）。follow は、タブから戻ったとき前に一番下にいたときだけ追う（#78）
export function useStickToBottom(trigger: string, follow: boolean) {
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
