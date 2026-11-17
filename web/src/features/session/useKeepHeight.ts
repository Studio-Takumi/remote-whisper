import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// 文字起こしの高さを、同じセッションのあいだは縮めない（#89。spec/ui.md 8）。縮むと一番下を見ているとき揺れて見える。
// 外側に min-height を付け、内側の高さを測る（min-height を外して測るとその瞬間に縮む）。key はセッション、content は中身
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
