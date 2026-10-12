import { useEffect, useRef } from 'react';

import { toast } from 'sonner';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useAppStore } from '@/store';
import { webVersion } from '@/version';

// 1時間ごとに、新しい版の画面がないかを確かめる
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// PWA の service worker を登録し、新しい版の画面が入ったら知らせて読み込み直す（#104・spec 8）。
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
            }
        },
    });
    const serverVersion = useAppStore((s) => s.serverVersion);
    const recording = useAppStore((s) => s.recordingState !== 'idle');

    useEffect(() => {
        if (serverVersion && serverVersion !== webVersion) {
            void registration.current?.update();
        }
    }, [serverVersion]);

    useEffect(() => {
        if (!needRefresh) {
            return;
        }
        const id = toast.info('新しい版の画面があります', {
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
