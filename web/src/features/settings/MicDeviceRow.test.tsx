// 設定の「録音に使うマイク」（#449）。許可の前・抜いたときの見せ方
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveChosenMic } from '@/features/recording/audio/micDevice';
import { MicDeviceRow } from '@/features/settings/MicDeviceRow';

const USB = { deviceId: 'usb', label: 'USB マイク' };
const BUILTIN = { deviceId: 'builtin', label: '内蔵マイク' };

let devices: { deviceId: string; label: string }[];
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
    localStorage.clear();
    devices = [BUILTIN, USB];
    getUserMedia = vi.fn(async () => {
        devices = [BUILTIN, USB];
        return { getTracks: () => [{ stop: () => {} }] };
    });
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => devices.map((d) => ({ kind: 'audioinput', ...d })),
            getUserMedia,
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('録音に使うマイク', () => {
    it('選んでいなければ「OS に任せる」', async () => {
        render(<MicDeviceRow />);
        expect((await screen.findByRole('combobox')).textContent).toBe('OS に任せる');
    });

    it('選んだマイクの名前を出す', async () => {
        saveChosenMic(USB);
        render(<MicDeviceRow />);
        expect((await screen.findByRole('combobox')).textContent).toBe('USB マイク');
    });

    it('選んだマイクがないときは、そう出し、OS の既定のマイクで録音することを出す', async () => {
        saveChosenMic(USB);
        devices = [BUILTIN];
        render(<MicDeviceRow />);
        await screen.findByText('つながっていないため、OS の既定のマイクで録音します');
        expect(screen.getByRole('combobox').textContent).toBe('USB マイク（見つかりません）');
    });

    it('許可の前は「許可する」を出し、押すと名前で選べるようになる', async () => {
        devices = [{ deviceId: '', label: '' }];
        render(<MicDeviceRow />);
        fireEvent.click(await screen.findByRole('button', { name: '許可する' }));
        await vi.waitFor(() => expect(screen.queryByText('マイクを許可すると選べます')).toBeNull());
        expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('一覧を取れないブラウザでは選べない', async () => {
        Reflect.deleteProperty(navigator, 'mediaDevices');
        render(<MicDeviceRow />);
        await screen.findByText('このブラウザでは選べません');
    });
});
