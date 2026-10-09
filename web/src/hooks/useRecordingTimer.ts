import { useEffect, useState } from 'react';

import type { RecordingState } from '@/recording';

// 録音の経過時間（秒）。一時停止中は止まる。録音を始めるときに reset を呼ぶ
export function useRecordingTimer(state: RecordingState) {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (state !== 'recording') {
            return;
        }
        const id = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(id);
    }, [state]);

    return { elapsed, reset: () => setElapsed(0) };
}

export function formatElapsed(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
