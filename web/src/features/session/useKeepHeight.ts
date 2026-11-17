import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// 文字起こしの高さを、同じセッションのあいだは縮めない（#89）
// 未確定部分は書き換わるたびに短くなることもあり、partial の行は final の行に置き換わったり消えたりする。
// 一番下を見ているときにページが縮むと位置が詰まり、伸びてまた下へ飛ぶ、を繰り返して揺れて見えるため。
// 余る高さは partial の 1 行分ほどで、次の行で埋まる
// 外側の箱に min-height を付け、内側の箱（中身）の高さを測る。min-height を外して測ると、
// その瞬間にページが縮んでスクロールの位置が詰まってしまう
// key はセッション（変わったら測り直す）、content は中身（変わったら高さを測る）
export function useKeepHeight(key: string, content: string) {
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
