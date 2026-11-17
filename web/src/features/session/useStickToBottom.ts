import { useEffect, useRef } from 'react';

import { isScrolledToBottom, scrollToBottom } from '@/lib/scroll';

// 新しい行が来たらページの一番下までスクロールする。ユーザーが上のほうを見ているときは追わない
// （下のマイクのボタンは sticky だが、ページの最後に場所を取るので、一番下なら最後の行は隠れない）
// trigger は中身が変わったら動かすためのキー。ページが伸びたときだけ動かす（縮んだときに動かすと揺れて見える。#89）
// follow は出したときに追うかどうか。タブを切り替えて戻ってきたときは、前に一番下にいたときだけ追う（#78）
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
