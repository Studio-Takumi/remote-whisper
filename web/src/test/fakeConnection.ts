// テスト用の偽の WebSocket 接続。api/connection.ts の connection の送受信を差し替え、
// 送ったもの（制御と音声）を順に記録し、サーバーからのメッセージ・切断・再接続をテストから起こす
import { vi } from 'vitest';

import type { connection as realConnection } from '@/api/connection';
import type { ClientMessage, ServerMessage } from '@/api/protocol';

// サーバーに届いたもの。音声は連番とサンプル数だけを残す
export type Wire = ClientMessage | { type: 'audio'; seq: number; samples: number };

export type FakeConnection = {
    wire: Wire[];
    connected: boolean;
    receive: (message: ServerMessage) => void;
    disconnect: () => void;
    reconnect: () => void;
    // 送ったものの type を順に（音声は 'audio:<連番>'）
    log: () => string[];
};

export function fakeConnection(connection: typeof realConnection): FakeConnection {
    const listeners = new Set<(m: ServerMessage) => void>();
    const stateListeners = new Set<(connected: boolean) => void>();
    const fake: FakeConnection = {
        wire: [],
        connected: false,
        receive: (message) => [...listeners].forEach((l) => l(message)),
        disconnect: () => {
            fake.connected = false;
            [...stateListeners].forEach((l) => l(false));
        },
        reconnect: () => {
            fake.connected = true;
            [...stateListeners].forEach((l) => l(true));
        },
        log: () => fake.wire.map((w) => (w.type === 'audio' ? `audio:${w.seq}` : w.type)),
    };
    vi.spyOn(connection, 'start').mockImplementation(() => fake.reconnect());
    vi.spyOn(connection, 'open').mockResolvedValue();
    vi.spyOn(connection, 'drop').mockImplementation(() => fake.disconnect());
    vi.spyOn(connection, 'subscribe').mockImplementation((listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    });
    vi.spyOn(connection, 'onStateChange').mockImplementation((listener) => {
        stateListeners.add(listener);
        return () => {
            stateListeners.delete(listener);
        };
    });
    // 切れている間に送ったものは届かない（本物も ws が null なので捨てる）
    vi.spyOn(connection, 'send').mockImplementation((message) => {
        if (fake.connected) {
            fake.wire.push(message);
        }
    });
    vi.spyOn(connection, 'sendBinary').mockImplementation((data) => {
        if (fake.connected) {
            const seq = new DataView(data).getUint32(0, true);
            fake.wire.push({ type: 'audio', seq, samples: (data.byteLength - 4) / 2 });
        }
    });
    return fake;
}
