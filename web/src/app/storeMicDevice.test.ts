import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { useAppStore as Store } from '@/app/store';
import { saveChosenMic } from '@/features/recording/audio/micDevice';
import { RETRY_DELAYS } from '@/features/recording/micRecovery';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects } from '@/test/seedProjects';

// 録音に使うマイクの選択（#449）。録音を始めるときも、自動・手動で開き直すときも、選んだマイクで開く
const SESSION = '2026-11-20_10-00-00';
const USB = { deviceId: 'usb', label: 'USB マイク' };
const BUILTIN = { deviceId: 'builtin', label: '内蔵マイク' };

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;
let devices: { deviceId: string; label: string }[];

async function startRecording() {
    vi.resetModules();
    const { connection } = await import('@/api/connection');
    const { Microphone, MicrophoneError } = await import('@/features/recording/audio/microphone');
    ws = fakeConnection(connection);
    mic = fakeMicrophone(Microphone, MicrophoneError);
    // OS の既定のマイクは内蔵のもの
    mic.labelOf = (deviceId) => [USB, BUILTIN].find((d) => d.deviceId === deviceId)?.label ?? BUILTIN.label;
    ({ useAppStore: store } = await import('@/app/store'));
    await seedProjects(store, [{ id: 'p1', name: 'p1', path: '/p1', sessions: [] }]);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const starting = store.getState().startRecording();
    await vi.waitFor(() => expect(ws.log()).toContain('start'));
    ws.receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
    await starting;
}

// USB マイクを抜く
function unplug() {
    devices = [BUILTIN];
    mic.missing.add(USB.deviceId);
}

beforeEach(() => {
    localStorage.clear();
    devices = [BUILTIN, USB];
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => devices.map((d) => ({ kind: 'audioinput', ...d })),
        },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(toast, 'success').mockImplementation(() => '');
    vi.spyOn(toast, 'warning').mockImplementation(() => '');
    vi.spyOn(toast, 'error').mockImplementation(() => '');
});

afterEach(async () => {
    vi.useRealTimers();
    await store?.getState().stopRecording();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('録音に使うマイク', () => {
    it('選んでいなければ、今までどおり OS に任せる', async () => {
        await startRecording();
        expect(mic.deviceIds).toEqual([undefined]);
    });

    it('選んだマイクで録音を始める', async () => {
        saveChosenMic(USB);
        await startRecording();
        expect(mic.deviceIds).toEqual(['usb']);
    });

    it('選んだマイクがなければ、OS に任せて録音を始め、知らせる', async () => {
        saveChosenMic(USB);
        devices = [BUILTIN];
        await startRecording();
        expect(mic.deviceIds).toEqual([undefined]);
        expect(toast.warning).toHaveBeenCalledWith(
            '選んだマイク（USB マイク）が見つからないため、OS の既定のマイクで録音します',
            expect.anything(),
        );
        expect(store.getState().recordingState).toBe('recording');
    });

    it('自動で開き直すときも選んだマイクで開き、戻ったらマイクの名前を添える', async () => {
        saveChosenMic(USB);
        await startRecording();
        mic.setState('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(mic.deviceIds).toEqual(['usb', 'usb']);
        expect(toast.success).toHaveBeenCalledWith('録音に戻りました（USB マイク）');
    });

    it('抜いたマイクは、自動で開き直すときに OS に任せ、そのことと名前を知らせる', async () => {
        saveChosenMic(USB);
        await startRecording();
        unplug();
        mic.setState('ended');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(mic.deviceIds.at(-1)).toBeUndefined();
        expect(store.getState().micState).toBe('ok');
        expect(toast.warning).toHaveBeenCalledWith(
            '選んだマイク（USB マイク）が見つからないため、OS の既定のマイクで録音します',
            expect.anything(),
        );
        expect(toast.success).toHaveBeenCalledWith('録音に戻りました（内蔵マイク）');
        // 同じセッションのまま
        mic.speak(8000);
        expect(ws.log()).toEqual(['start', 'audio:0']);
    });

    it('手動で開き直すときも選んだマイクで開く', async () => {
        saveChosenMic(USB);
        await startRecording();
        mic.setState('ended');
        await store.getState().reopenMicrophone();
        expect(mic.deviceIds).toEqual(['usb', 'usb']);
        expect(toast.success).toHaveBeenCalledWith('マイクを開き直しました。録音を続けています（USB マイク）');
    });

    it('録音中に選び直すと、同じセッションのまま選んだマイクに切り替える', async () => {
        await startRecording();
        mic.speak(8000);
        saveChosenMic(USB);
        await store.getState().switchMicrophone();
        expect(mic.deviceIds).toEqual([undefined, 'usb']);
        expect(mic.opened - mic.closed).toBe(1);
        expect(toast.success).toHaveBeenCalledWith('マイクを切り替えました。録音を続けています（USB マイク）');
        mic.speak(8000);
        expect(ws.log()).toEqual(['start', 'audio:0', 'audio:1']);
        expect(store.getState().recordingSessionId).toBe(SESSION);
    });

    it('録音していなければ、選び直してもマイクを開かない', async () => {
        await startRecording();
        await store.getState().stopRecording();
        saveChosenMic(USB);
        await store.getState().switchMicrophone();
        expect(mic.deviceIds).toEqual([undefined]);
    });

    it('自動で開き直している途中に選び直すと、終わるのを待ってから選んだマイクで開き直す', async () => {
        await startRecording();
        let release = () => {};
        mic.gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        mic.setState('muted');
        // 自動の開き直しが、選び直す前の選択（OS に任せる）で開いている途中
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(mic.deviceIds).toEqual([undefined, undefined]);
        saveChosenMic(USB);
        const switching = store.getState().switchMicrophone();
        mic.gate = null;
        release();
        await switching;
        expect(mic.deviceIds).toEqual([undefined, undefined, 'usb']);
        expect(mic.opened - mic.closed).toBe(1);
        expect(toast.success).toHaveBeenCalledWith('マイクを切り替えました。録音を続けています（USB マイク）');
        expect(toast.success).not.toHaveBeenCalledWith('マイクを切り替えました。録音を続けています（内蔵マイク）');
        mic.speak(8000);
        expect(ws.log()).toEqual(['start', 'audio:0']);
    });
});
