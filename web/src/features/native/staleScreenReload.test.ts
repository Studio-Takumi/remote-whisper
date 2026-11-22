// iOS アプリで、サーバーが新しい版になったときの画面の読み込み直し（#461。spec/mobile.md 11.7）。
// ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { AppState, AppStore } from '@/app/appState';
import { RELOADED_FOR_KEY, StaleScreenReloader } from '@/features/native/staleScreenReload';

const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));
const startBridge = vi.hoisted(() => vi.fn());

vi.mock('@/features/native/nativeBridge', () => {
    loaded.bridge++;
    return { startStaleScreenReload: startBridge, startNativeShell: vi.fn(), Recorder: {} };
});

vi.mock('@capacitor/core', () => {
    loaded.core++;
    return {};
});

function setCapacitor(capacitor: { isNativePlatform: () => boolean } | null) {
    const w = window as { Capacitor?: unknown };
    if (capacitor) {
        w.Capacitor = capacitor;
    } else {
        delete w.Capacitor;
    }
}

describe('startStaleScreenReload', () => {
    beforeEach(() => {
        vi.resetModules();
        loaded.bridge = 0;
        loaded.core = 0;
        startBridge.mockClear();
    });
    afterEach(() => setCapacitor(null));

    it('does nothing in the browser and loads no native code', async () => {
        const { startStaleScreenReload } = await import('@/features/native/nativePlatform');
        startStaleScreenReload(createStore<AppState>(() => ({}) as AppState));
        await Promise.resolve();
        expect(loaded).toEqual({ bridge: 0, core: 0 });
    });

    it('starts the bridge inside the app', async () => {
        setCapacitor({ isNativePlatform: () => true });
        const { startStaleScreenReload } = await import('@/features/native/nativePlatform');
        startStaleScreenReload(createStore<AppState>(() => ({}) as AppState));
        await vi.waitFor(() => expect(startBridge).toHaveBeenCalledTimes(1));
    });
});

describe('StaleScreenReloader', () => {
    let store: AppStore;
    let reload: ReturnType<typeof vi.fn>;
    let refresh: ReturnType<typeof vi.fn>;
    let stop: () => void;

    const make = (state: Partial<AppState>) => {
        store = createStore<AppState>(() => ({ serverVersion: null, recordingState: 'idle', ...state }) as AppState);
        reload = vi.fn();
        refresh = vi.fn(() => Promise.resolve());
        stop = new StaleScreenReloader(store, { webVersion: 'v1', refreshServerVersion: refresh, reload }).start();
    };
    const set = (state: Partial<AppState>) => store.setState(state);

    beforeEach(() => sessionStorage.clear());
    afterEach(() => stop());

    it('does not reload when the versions match or the server version is unknown', () => {
        make({ serverVersion: 'v1' });
        set({ serverVersion: null });
        expect(reload).not.toHaveBeenCalled();
    });

    it('reloads when the server version differs on connect', () => {
        make({});
        set({ serverVersion: 'v2' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('waits for the recording to end', () => {
        make({ serverVersion: 'v2', recordingState: 'recording' });
        expect(reload).not.toHaveBeenCalled();
        set({ recordingState: 'paused' });
        expect(reload).not.toHaveBeenCalled();
        set({ recordingState: 'idle' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('re-fetches the version and reloads when the app comes back to the front', async () => {
        make({ serverVersion: 'v1' });
        refresh.mockImplementation(() => {
            set({ serverVersion: 'v2' });
            return Promise.resolve();
        });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not reload again for the same version', () => {
        make({ serverVersion: 'v2' });
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(RELOADED_FOR_KEY)).toBe('v2');
        set({ recordingState: 'recording' });
        set({ recordingState: 'idle' });
        expect(reload).toHaveBeenCalledTimes(1);
        // 次の版には読み込み直す
        set({ serverVersion: 'v3' });
        expect(reload).toHaveBeenCalledTimes(2);
    });
});
