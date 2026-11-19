// テスト用の偽のマイク。Microphone.open を差し替え、テストから音声（無音の PCM）を流す
import { vi } from 'vitest';

import type {
    MicState,
    PcmHandler,
    Microphone as RealMicrophone,
    MicrophoneError as RealMicrophoneError,
} from '@/features/recording/audio/microphone';

export type FakeMicrophone = {
    // samples 個のサンプル（16kHz）を流す。8000 で 1 チャンク
    speak: (samples: number) => void;
    // 今開いているマイクの状態を変える（割り込みでトラックが止まったときなど。#447）
    setState: (state: MicState) => void;
    // 次に開くマイクの状態（開き直してもまだ止まっているときを試す）
    openState: MicState;
    // 置くと、開くのをこれが終わるまで待たせる（開き直している途中を試す）
    gate: Promise<void> | null;
    opened: number;
    closed: number;
    // 開くときに渡された deviceId（OS に任せたときは undefined。#449）
    deviceIds: (string | undefined)[];
    // ない（外した）ことにするマイクの deviceId。開こうとすると missing で失敗する
    missing: Set<string>;
    // 開いたマイクの名前（deviceId を渡さなければ OS の既定のマイク）
    labelOf: (deviceId: string | undefined) => string;
};

// missing を試すときは、同じモジュールの MicrophoneError を渡す（vi.resetModules のあとはクラスが別になるため）
export function fakeMicrophone(
    Microphone: typeof RealMicrophone,
    MicrophoneError?: typeof RealMicrophoneError,
): FakeMicrophone {
    let onPcm: PcmHandler | null = null;
    let current: { state: MicState; onState?: (state: MicState) => void } | null = null;
    const fake: FakeMicrophone = {
        speak: (samples) => onPcm?.(new Int16Array(samples), 0.5),
        setState: (state) => {
            if (current) {
                current.state = state;
                current.onState?.(state);
            }
        },
        openState: 'ok',
        gate: null,
        opened: 0,
        closed: 0,
        deviceIds: [],
        missing: new Set(),
        labelOf: () => '',
    };
    vi.spyOn(Microphone, 'open').mockImplementation(async (handler, _processing, onState, deviceId) => {
        fake.deviceIds.push(deviceId);
        if (deviceId && fake.missing.has(deviceId) && MicrophoneError) {
            throw new MicrophoneError('missing', '選んだマイクが見つかりません');
        }
        fake.opened += 1;
        if (fake.gate) {
            await fake.gate;
        }
        onPcm = handler;
        const opened = { state: fake.openState, onState };
        current = opened;
        onState?.(opened.state);
        const mic = {
            flush: async () => {},
            discard: () => {},
            restart: async () => {},
            state: () => opened.state,
            label: () => fake.labelOf(deviceId),
            close: () => {
                fake.closed += 1;
                if (current === opened) {
                    onPcm = null;
                    current = null;
                }
            },
        };
        return mic as unknown as RealMicrophone;
    });
    return fake;
}
