// テスト用の偽のマイク。Microphone.open を差し替え、テストから音声（無音の PCM）を流す
import { vi } from 'vitest';

import type { PcmHandler, Microphone as RealMicrophone } from '@/features/recording/audio/microphone';

export type FakeMicrophone = {
    // samples 個のサンプル（16kHz）を流す。8000 で 1 チャンク
    speak: (samples: number) => void;
    opened: number;
    closed: number;
};

export function fakeMicrophone(Microphone: typeof RealMicrophone): FakeMicrophone {
    let onPcm: PcmHandler | null = null;
    const fake: FakeMicrophone = {
        speak: (samples) => onPcm?.(new Int16Array(samples), 0.5),
        opened: 0,
        closed: 0,
    };
    vi.spyOn(Microphone, 'open').mockImplementation(async (handler, _processing, onState) => {
        fake.opened += 1;
        onPcm = handler;
        onState?.('ok');
        const mic = {
            flush: async () => {},
            discard: () => {},
            restart: async () => {},
            close: () => {
                fake.closed += 1;
                onPcm = null;
            },
        };
        return mic as unknown as RealMicrophone;
    });
    return fake;
}
