import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findChosen,
    listMicInputs,
    loadChosenMic,
    openChosenMicrophone,
    saveChosenMic,
} from '@/features/recording/audio/micDevice';
import { Microphone, MicrophoneError } from '@/features/recording/audio/microphone';

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
    const onFallback = vi.fn();

    beforeEach(() => {
        opened = [];
        missing = new Set();
        onFallback.mockReset();
        vi.spyOn(Microphone, 'open').mockImplementation(async (_onPcm, _processing, _onState, deviceId) => {
            if (deviceId && missing.has(deviceId)) {
                throw new MicrophoneError('missing', '選んだマイクが見つかりません');
            }
            opened.push(deviceId);
            return {} as Microphone;
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
});
