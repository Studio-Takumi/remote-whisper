import { useEffect, useState } from 'react';

// active の間、1秒ごとに今の時刻を返す（経過時間を進めるため）
export function useNow(active: boolean) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        // 開いた直後にも今の時刻にする（閉じている間は止めているので古い）
        const first = setTimeout(() => setNow(Date.now()), 0);
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [active]);
    return now;
}
