import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/api';
import { type SetupStatus, isBusy, normalizeSetup } from '@/setup';
import { useAppStore } from '@/store';

// セットアップの状態（GET /api/setup。#291）。取っている・入れている間は 1 秒ごとに取り直す。
// 終わったら、設定で選べる値（Ollama のモデル・浄書できるか）も取り直す。
// onFirst は最初に届いたときに 1 回だけ呼ぶ（初回の「はじめに」を出すかを決める）
export function useSetupStatus(enabled: boolean, onFirst?: (status: SetupStatus) => void) {
    const [status, setRawStatus] = useState<SetupStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const wasBusy = useRef(false);
    const first = useRef(onFirst);
    // 古いホスト（#327 より前。llm がなく ollama で返す）の形も読めるようにそろえる
    const setStatus = useCallback((s: SetupStatus) => setRawStatus(normalizeSetup(s)), []);

    const refresh = useCallback(async () => {
        try {
            setStatus(await api.get<SetupStatus>('/api/setup'));
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'セットアップの状態を取得できませんでした');
        }
    }, [setStatus]);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        api.get<SetupStatus>('/api/setup')
            .then((raw) => {
                if (cancelled) {
                    return;
                }
                const s = normalizeSetup(raw);
                setRawStatus(s);
                first.current?.(s);
                first.current = undefined;
            })
            .catch((e: Error) => !cancelled && setError(e.message));
        return () => {
            cancelled = true;
        };
    }, [enabled]);

    // 取っている・入れている間は取り直す。終わったら選べる値も取り直す
    const busy = status !== null && isBusy(status);
    useEffect(() => {
        if (wasBusy.current && !busy) {
            void useAppStore.getState().loadOptions();
        }
        wasBusy.current = busy;
    }, [busy]);
    useEffect(() => {
        if (!enabled || !busy) {
            return;
        }
        const id = setTimeout(() => void refresh(), 1000);
        return () => clearTimeout(id);
    }, [enabled, busy, status, refresh]);

    return { status, setStatus, refresh, error };
}
