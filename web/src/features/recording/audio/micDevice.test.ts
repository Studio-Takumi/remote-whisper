import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findChosen,
    listMicInputs,
    loadChosenMic,
    openChosenMicrophone,
    saveChosenMic,
} from '@/features/recording/audio/micDevice';
import { Microphone, MicrophoneError } from '@/features/recording/audio/microphone';

// iOS アプリの中で、開いたマイクを iOS に伝えるところ（#458）。ネイティブを呼ぶコードは偽物にする
const nativeBridge = vi.hoisted(() => ({
    loaded: 0,
    setPreferredMicInput: vi.fn(async (_label: string | null) => {}),
}));

vi.mock('@/features/native/nativeBridge', () => {
    nativeBridge.loaded++;
    return { setPreferredMicInput: nativeBridge.setPreferredMicInput };
});

// 録音に使うマイクの選択（#449）
const PROCESSING = { noiseSuppression: true, autoGainControl: true, echoCancellation: true };
const USB = { deviceId: 'usb', label: 'USB マイク' };
const BUILTIN = { deviceId: 'builtin', label: '内蔵マイク' };

function stubDevices(devices: { deviceId: string; label: string; kind?: MediaDeviceKind }[]) {
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => devices.map((d) => ({ kind: 'audioinput', ...d })),
        },
    });
}

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('選んだマイクを覚える', () => {
    it('選んでいなければ null（OS に任せる）', () => {
        expect(loadChosenMic()).toBeNull();
    });

    it('選んだものを覚え、null で忘れる', () => {
        saveChosenMic(USB);
        expect(loadChosenMic()).toEqual(USB);
        saveChosenMic(null);
        expect(loadChosenMic()).toBeNull();
    });

    it('壊れた値は OS に任せる', () => {
        localStorage.setItem('rw.micDevice', '{');
        expect(loadChosenMic()).toBeNull();
        localStorage.setItem('rw.micDevice', JSON.stringify({ deviceId: '', label: 'x' }));
        expect(loadChosenMic()).toBeNull();
        localStorage.setItem('rw.micDevice', JSON.stringify({ deviceId: 'usb' }));
        expect(loadChosenMic()).toBeNull();
        localStorage.setItem('rw.micDevice', JSON.stringify({ deviceId: 1, label: 'x' }));
        expect(loadChosenMic()).toBeNull();
        localStorage.setItem('rw.micDevice', 'null');
        expect(loadChosenMic()).toBeNull();
    });

    it('localStorage が例外を投げても、OS に任せる（保存は黙って諦める）', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        expect(() => saveChosenMic(USB)).not.toThrow();
        expect(loadChosenMic()).toBeNull();
    });

    it('localStorage そのものを使えないときも、OS に任せる', () => {
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(() => saveChosenMic(USB)).not.toThrow();
        expect(loadChosenMic()).toBeNull();
    });
});

describe('マイクの一覧', () => {
    it('マイクだけを出し、Chrome の「既定」「通信」は出さない', async () => {
        stubDevices([
            { deviceId: 'default', label: '既定 - USB マイク' },
            { deviceId: 'communications', label: '通信 - USB マイク' },
            USB,
            { deviceId: 'speaker', label: 'スピーカー', kind: 'audiooutput' },
        ]);
        expect(await listMicInputs()).toEqual([USB]);
    });

    it('一覧を取れないブラウザでは null', async () => {
        expect(await listMicInputs()).toBeNull();
    });
});

describe('選んだマイクを探す', () => {
    it('ID が同じもの、なければ名前が同じもの', () => {
        expect(findChosen(USB, [BUILTIN, USB])).toEqual(USB);
        expect(findChosen(USB, [BUILTIN, { deviceId: 'usb-2', label: 'USB マイク' }])).toEqual({
            deviceId: 'usb-2',
            label: 'USB マイク',
        });
    });

    it('見つからなければ null、許可の前（名前がない）は分からないので undefined', () => {
        expect(findChosen(USB, [BUILTIN])).toBeNull();
        expect(findChosen(USB, [{ deviceId: '', label: '' }])).toBeUndefined();
    });
});

describe('選んだマイクで開く', () => {
    let opened: (string | undefined)[];
    let missing: Set<string>;
    let trackLabels: Map<string, string>;
    const onFallback = vi.fn();

    beforeEach(() => {
        opened = [];
        missing = new Set();
        onFallback.mockReset();
        trackLabels = new Map();
        vi.spyOn(Microphone, 'open').mockImplementation(async (_onPcm, _processing, _onState, deviceId) => {
            if (deviceId && missing.has(deviceId)) {
                throw new MicrophoneError('missing', '選んだマイクが見つかりません');
            }
            opened.push(deviceId);
            // 開いたマイクのトラックの名前（track.label）。決めていなければ空
            return { label: () => trackLabels.get(deviceId ?? '') ?? '' } as Microphone;
        });
    });

    const open = () =>
        openChosenMicrophone(
            () => {},
            PROCESSING,
            () => {},
            onFallback,
        );

    it('選んでいなければ、今までどおり deviceId を渡さない', async () => {
        await open();
        expect(opened).toEqual([undefined]);
        expect(onFallback).not.toHaveBeenCalled();
    });

    it('選んだマイクがあれば、その ID で開く', async () => {
        saveChosenMic(USB);
        stubDevices([BUILTIN, USB]);
        await open();
        expect(opened).toEqual(['usb']);
    });

    it('ID が変わっていたら、名前で探して覚え直す', async () => {
        saveChosenMic(USB);
        stubDevices([BUILTIN, { deviceId: 'usb-2', label: 'USB マイク' }]);
        await open();
        expect(opened).toEqual(['usb-2']);
        expect(loadChosenMic()).toEqual({ deviceId: 'usb-2', label: 'USB マイク' });
    });

    it('選んだマイクがなければ OS に任せて開き、知らせる（選んだものは覚えたまま）', async () => {
        saveChosenMic(USB);
        stubDevices([BUILTIN]);
        await open();
        expect(opened).toEqual([undefined]);
        expect(onFallback).toHaveBeenCalledWith(USB);
        expect(loadChosenMic()).toEqual(USB);
    });

    it('許可の前は覚えている ID で試し、なければ OS に任せる', async () => {
        saveChosenMic(USB);
        stubDevices([{ deviceId: '', label: '' }]);
        missing.add('usb');
        await open();
        expect(opened).toEqual([undefined]);
        expect(onFallback).toHaveBeenCalledWith(USB);
    });

    it('許可されなかったときは OS に任せず、そのまま失敗する', async () => {
        saveChosenMic(USB);
        vi.mocked(Microphone.open).mockRejectedValue(new MicrophoneError('denied', '許可されていません'));
        await expect(open()).rejects.toMatchObject({ reason: 'denied' });
        expect(onFallback).not.toHaveBeenCalled();
    });

    it('localStorage が例外を投げるときは、今までどおり OS に任せて開く', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        await open();
        expect(opened).toEqual([undefined]);
        expect(onFallback).not.toHaveBeenCalled();
    });

    describe('iOS アプリの中では、開いたマイクを iOS に伝える（#458）', () => {
        const setCapacitor = (native: boolean) => {
            (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => native };
        };

        beforeEach(() => {
            nativeBridge.setPreferredMicInput.mockClear();
            nativeBridge.setPreferredMicInput.mockResolvedValue(undefined);
        });

        afterEach(() => {
            Reflect.deleteProperty(window, 'Capacitor');
        });

        it('ブラウザでは伝えず、ネイティブを呼ぶコードも読み込まない', async () => {
            saveChosenMic(BUILTIN);
            stubDevices([BUILTIN, USB]);
            await open();
            await new Promise((r) => setTimeout(r, 0));
            expect(nativeBridge.loaded).toBe(0);
            expect(nativeBridge.setPreferredMicInput).not.toHaveBeenCalled();
        });

        it('選んだマイクで開けたら、その名前を伝える', async () => {
            setCapacitor(true);
            saveChosenMic(BUILTIN);
            stubDevices([BUILTIN, USB]);
            await open();
            await vi.waitFor(() => expect(nativeBridge.setPreferredMicInput).toHaveBeenCalledWith('内蔵マイク'));
        });

        it('覚えている名前が古くても、開いたマイクの今の名前を伝える（ID が同じで名前だけ変わったとき）', async () => {
            setCapacitor(true);
            saveChosenMic({ deviceId: 'builtin', label: '古い名前' });
            stubDevices([{ deviceId: 'builtin', label: '新しい名前' }]);
            trackLabels.set('builtin', '新しい名前');
            await open();
            expect(opened).toEqual(['builtin']);
            await vi.waitFor(() => expect(nativeBridge.setPreferredMicInput).toHaveBeenCalledWith('新しい名前'));
        });

        it('許可の前に覚えている ID で開けたときも、開いたマイクの名前を伝える', async () => {
            setCapacitor(true);
            saveChosenMic(BUILTIN);
            stubDevices([{ deviceId: '', label: '' }]);
            trackLabels.set('builtin', 'iPhone のマイク');
            await open();
            expect(opened).toEqual(['builtin']);
            await vi.waitFor(() => expect(nativeBridge.setPreferredMicInput).toHaveBeenCalledWith('iPhone のマイク'));
        });

        it('OS に任せるとき・選んだマイクがなかったときは null（固定を外す）', async () => {
            setCapacitor(true);
            await open();
            await vi.waitFor(() => expect(nativeBridge.setPreferredMicInput).toHaveBeenLastCalledWith(null));
            nativeBridge.setPreferredMicInput.mockClear();
            saveChosenMic(USB);
            stubDevices([BUILTIN]);
            await open();
            await vi.waitFor(() => expect(nativeBridge.setPreferredMicInput).toHaveBeenLastCalledWith(null));
        });

        it('伝えられなくても、マイクは開ける', async () => {
            setCapacitor(true);
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            nativeBridge.setPreferredMicInput.mockRejectedValue(new Error('not registered'));
            saveChosenMic(BUILTIN);
            stubDevices([BUILTIN]);
            await expect(open()).resolves.toBeDefined();
            await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
        });
    });
});
