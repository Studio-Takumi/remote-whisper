import { useEffect, useRef } from 'react';

import { toast } from 'sonner';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useAppStore } from '@/store';
import { webVersion } from '@/version';

// 1時間ごとに、新しい版の画面がないかを確かめる
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// PWA の service worker を登録し、新しい版の画面が入ったら知らせて読み込み直す（#104・spec/ui.md 8）。
// サーバーのバージョン（#97）が画面と違ったら（サーバーを更新した）、すぐに確かめる
export function PwaUpdater() {
    const registration = useRef<ServiceWorkerRegistration | null>(null);
    const {
        needRefresh: [needRefresh],
        updateServiceWorker,
    } = useRegisterSW({
        onRegisteredSW(_url, r) {
            registration.current = r ?? null;
            if (r) {
                setInterval(() => void r.update(), CHECK_INTERVAL_MS);
                // 登録より先にサーバーのバージョンが届いていたら、ここで確かめる
                const server = useAppStore.getState().serverVersion;
                if (server && server !== webVersion) {
                    void r.update();
                }
            }
        },
    });
    const serverVersion = useAppStore((s) => s.serverVersion);
    const recording = useAppStore((s) => s.recordingState !== 'idle');

    // 古い版の画面のまま、サーバーではもう消えた JS を読もうとして失敗したら（ビルドし直した後）、
    // 新しい版を確かめて、読み込み直すように知らせる
    useEffect(() => {
        const onPreloadError = (e: Event) => {
            e.preventDefault();
            void registration.current?.update();
            toast.warning('画面の一部を読み込めません（ホストが新しいバージョンになりました）', {
                description: '読み込み直すと直ります',
                duration: Infinity,
                action: { label: '読み込み直す', onClick: () => location.reload() },
            });
        };
        window.addEventListener('vite:preloadError', onPreloadError);
        return () => window.removeEventListener('vite:preloadError', onPreloadError);
    }, []);

    useEffect(() => {
        if (serverVersion && serverVersion !== webVersion) {
            void registration.current?.update();
        }
    }, [serverVersion]);

    useEffect(() => {
        if (!needRefresh) {
            return;
        }
        const id = toast.info('新しいバージョンの画面があります', {
            description: recording ? '録音を終えてから更新してください' : '更新すると、読み込み直します',
            duration: Infinity,
            action: recording ? undefined : { label: '更新', onClick: () => void updateServiceWorker(true) },
        });
        return () => {
            toast.dismiss(id);
        };
    }, [needRefresh, recording, updateServiceWorker]);

    return null;
}
