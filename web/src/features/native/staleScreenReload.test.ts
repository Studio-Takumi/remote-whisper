// iOS アプリで、サーバーが新しい版になったときの画面の読み込み直し（#461。spec/mobile.md 11.8）。
// ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { AppState, AppStore } from '@/app/appState';
import { RELOADED_FOR_KEY, SETTLE_MS, StaleScreenReloader } from '@/features/native/staleScreenReload';

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
    let reload: Mock<() => void>;
    let refresh: Mock<() => Promise<void>>;
    let stop: () => void;

    const make = (state: Partial<AppState> = {}, cloud = false) => {
        store = createStore<AppState>(
            () =>
                ({
                    serverVersion: null,
                    recordingState: 'idle',
                    joined: null,
                    pendingAudio: 0,
                    uploading: null,
                    pickedAudio: null,
                    unsent: null,
                    settingsOpen: false,
                    newProjectOpen: false,
                    server: { connection: 'connected' },
                    ...state,
                }) as unknown as AppState,
        );
        reload = vi.fn<() => void>();
        refresh = vi.fn<() => Promise<void>>(() => Promise.resolve());
        stop = new StaleScreenReloader(store, {
            webVersion: 'v1',
            cloud,
            refreshServerVersion: refresh,
            reload,
        }).start();
    };
    const set = (state: Partial<AppState>) => store.setState(state);

    beforeEach(() => {
        sessionStorage.clear();
        vi.useFakeTimers();
    });
    afterEach(() => {
        stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not reload when the versions match or the server version is unknown', () => {
        make({ serverVersion: 'v1' });
        set({ serverVersion: null });
        expect(reload).not.toHaveBeenCalled();
    });

    it('reloads when the server version differs on connect', () => {
        make();
        set({ serverVersion: 'v2' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('waits for the recording to end, then for the last audio and stop to reach the server', () => {
        make({ serverVersion: 'v2', recordingState: 'recording' });
        expect(reload).not.toHaveBeenCalled();
        set({ recordingState: 'paused' });
        set({ recordingState: 'idle' });
        // 終えた直後は読み込み直さない
        expect(reload).not.toHaveBeenCalled();
        vi.advanceTimersByTime(SETTLE_MS);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('waits for the stop that was held while offline until it reconnects and settles', () => {
        make({
            serverVersion: 'v2',
            recordingState: 'recording',
            server: { connection: 'reconnecting' },
        } as Partial<AppState>);
        set({ recordingState: 'idle' });
        vi.advanceTimersByTime(SETTLE_MS * 5);
        set({ server: { connection: 'connected' } } as Partial<AppState>);
        expect(reload).not.toHaveBeenCalled();
        vi.advanceTimersByTime(SETTLE_MS);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['joined', { joined: {} }, { joined: null }],
        ['pending audio', { pendingAudio: 2 }, { pendingAudio: 0 }],
        ['uploading', { uploading: { projectId: 'p', name: 'a', percent: 5 } }, { uploading: null }],
        ['picked audio', { pickedAudio: { projectId: 'p', files: [] } }, { pickedAudio: null }],
        ['unsent', { unsent: { sessionId: 's', projectId: 'p', seconds: 1 } }, { unsent: null }],
        ['settings', { settingsOpen: true }, { settingsOpen: false }],
        ['new project', { newProjectOpen: true }, { newProjectOpen: false }],
    ] as [string, Partial<AppState>, Partial<AppState>][])('waits while %s, reloads after', (_name, on, off) => {
        make({ serverVersion: 'v2', ...on });
        expect(reload).not.toHaveBeenCalled();
        set(off);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does nothing in the cloud version', () => {
        make({ serverVersion: 'v2' }, true);
        set({ serverVersion: 'v3' });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(reload).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('skips while typing in an input', () => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        make({ serverVersion: 'v2' });
        expect(reload).not.toHaveBeenCalled();
        input.remove();
    });

    it.each(['unknown', 'abc123+dirty'])('does not compare when the server version is %s', (v) => {
        make({ serverVersion: v });
        expect(reload).not.toHaveBeenCalled();
    });

    it('re-fetches the version and reloads when the app comes back to the front', async () => {
        vi.useRealTimers();
        make({ serverVersion: 'v1' });
        refresh.mockImplementation(() => {
            set({ serverVersion: 'v2' });
            return Promise.resolve();
        });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not re-fetch while hidden', () => {
        make({ serverVersion: 'v1' });
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not reload when sessionStorage cannot be written', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        make({ serverVersion: 'v2' });
        expect(reload).not.toHaveBeenCalled();
    });

    it('does not reload again for the same version', () => {
        make({ serverVersion: 'v2' });
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(RELOADED_FOR_KEY)).toBe('v2');
        set({ pendingAudio: 1 });
        set({ pendingAudio: 0 });
        expect(reload).toHaveBeenCalledTimes(1);
        // 次の版には読み込み直す
        set({ serverVersion: 'v3' });
        expect(reload).toHaveBeenCalledTimes(2);
    });
});
