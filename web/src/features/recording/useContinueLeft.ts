import { useEffect, useState } from 'react';

import type { Session } from '@/api/types';
import { continueLeftSec } from '@/features/recording/continueWindow';

// 開いているセッションの続きから録音できる残りの秒数（#174）。続けられないなら null。
// 続けられる間だけ 5 秒ごとに時計を進める
export function useContinueLeft(session: Session | undefined, windowMin: number, idle: boolean) {
    const [now, setNow] = useState(() => Date.now());
    const left = session && idle ? continueLeftSec(session, windowMin, now) : null;
    const active = left !== null;
    useEffect(() => {
        if (!active) {
            return;
        }
        const tick = () => setNow(Date.now());
        // 止まっていた間に古くなった時刻は、すぐ取り直す
        const first = setTimeout(tick, 0);
        const timer = setInterval(tick, 5000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [active]);
    return left;
}
