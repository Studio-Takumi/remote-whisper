// iOS アプリの録音のプラグインの状態を画面に出す（検証用。#438）。イベントを購読し、外すときは解除する
import { useCallback, useEffect, useState } from 'react';

import type { RecorderPlugin, RecorderReason, RecorderState, RecordingFile } from '@/features/native/recorderTypes';

// 失敗したときの code（spec/mobile.md 11.3）ごとの文言
const ERROR_MESSAGES: Record<string, string> = {
    'permission-denied': 'マイクが許可されていません。設定アプリで許可してください',
    'no-input': 'マイクが見つかりません',
    'already-recording': 'すでに録音中です',
    'not-recording': '録音していません',
    'not-found': 'ファイルが見つかりません',
    busy: '録音中のファイルは削除できません',
};

export function recorderErrorMessage(e: unknown) {
    const { code, message } = (e ?? {}) as { code?: string; message?: string };
    return (code && ERROR_MESSAGES[code]) ?? `失敗しました（${code ?? message ?? '不明'}）`;
}

export type RecorderView = {
    state: RecorderState;
    // 録っているファイルの名前
    file?: string;
    // 録った長さ（秒）
    seconds: number;
    // 最後に状態が変わった理由
    reason?: RecorderReason;
    files: RecordingFile[];
    error: string | null;
};

const INITIAL: RecorderView = { state: 'idle', seconds: 0, files: [], error: null };

export function useRecorder(plugin: RecorderPlugin) {
    const [view, setView] = useState<RecorderView>(INITIAL);
    const update = (patch: Partial<RecorderView>) => setView((v) => ({ ...v, ...patch }));

    const refresh = useCallback(async () => {
        try {
            const { files } = await plugin.listRecordings();
            setView((v) => ({ ...v, files }));
        } catch (e) {
            setView((v) => ({ ...v, error: recorderErrorMessage(e) }));
        }
    }, [plugin]);

    useEffect(() => {
        let active = true;
        // 購読できなかったら（プラグインが登録されていないなど）文言を出し、未処理の reject にしない
        const failed = (e: unknown) => {
            if (active) {
                setView((v) => ({ ...v, error: recorderErrorMessage(e) }));
            }
            return null;
        };
        const handles = [
            plugin.addListener('stateChange', (e) => {
                setView((v) => ({
                    ...v,
                    state: e.state,
                    reason: e.reason,
                    file: e.state === 'idle' ? undefined : (e.file?.name ?? v.file),
                }));
                if (e.state === 'idle') {
                    void refresh();
                }
            }),
            plugin.addListener('progress', (e) => setView((v) => ({ ...v, seconds: e.seconds }))),
        ].map((handle) => handle.catch(failed));
        void plugin
            .getStatus()
            .then((s) => active && setView((v) => ({ ...v, state: s.state, file: s.file, seconds: s.seconds })))
            .catch((e: unknown) => active && setView((v) => ({ ...v, error: recorderErrorMessage(e) })));
        void plugin
            .listRecordings()
            .then(({ files }) => active && setView((v) => ({ ...v, files })))
            .catch((e: unknown) => active && setView((v) => ({ ...v, error: recorderErrorMessage(e) })));
        return () => {
            active = false;
            // addListener は Promise を返すので、解決してから外す
            for (const handle of handles) {
                void handle.then((h) => h?.remove()).catch(() => {});
            }
        };
    }, [plugin, refresh]);

    const start = async () => {
        update({ error: null });
        try {
            const { file } = await plugin.start();
            setView((v) => ({ ...v, state: 'recording', reason: 'user', file, seconds: 0 }));
            void refresh();
        } catch (e) {
            update({ error: recorderErrorMessage(e) });
        }
    };

    const stop = async () => {
        update({ error: null });
        try {
            await plugin.stop();
            setView((v) => ({ ...v, state: 'idle', reason: 'user', file: undefined }));
        } catch (e) {
            update({ error: recorderErrorMessage(e) });
        }
        void refresh();
    };

    const remove = async (name: string) => {
        update({ error: null });
        try {
            await plugin.deleteRecording({ name });
        } catch (e) {
            update({ error: recorderErrorMessage(e) });
        }
        void refresh();
    };

    return { view, start, stop, remove, refresh, setError: (error: string | null) => update({ error }) };
}
