// iOS アプリで録ったファイルを、readRecording で分けて読んでつなぎ、File にする（spec/mobile.md 11.3）
import { describe, expect, it, vi } from 'vitest';

import type { RecordingChunk, RecordingFile } from '@/features/native/recorderTypes';
import { READ_CHUNK_BYTES, decodeBase64, readRecordingFile } from '@/features/native/recordingFile';

function toBase64(bytes: Uint8Array) {
    let s = '';
    for (const b of bytes) {
        s += String.fromCharCode(b);
    }
    return btoa(s);
}

// readRecording の偽物。chunk バイトずつ返す（ネイティブの上限の代わり）
function fakePlugin(content: Uint8Array, chunk: number) {
    return {
        readRecording: vi.fn(async ({ offset = 0, length = READ_CHUNK_BYTES }): Promise<RecordingChunk> => {
            const part = content.slice(offset, offset + Math.min(length, chunk));
            return { data: toBase64(part), offset, size: content.length };
        }),
    };
}

const file = (size: number): RecordingFile => ({
    name: 'recording-20261119-120000.wav',
    durationSec: 10,
    size,
    createdAt: '2026-11-19T12:00:00+09:00',
    modifiedAt: '2026-11-19T12:00:10+09:00',
});

describe('readRecordingFile', () => {
    it('base64 を分けて読み、順につないで File にする', async () => {
        const content = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7) % 256);
        const plugin = fakePlugin(content, 1000);
        const progress: number[] = [];
        const result = await readRecordingFile(plugin, file(content.length), (p) => progress.push(p));

        expect(plugin.readRecording.mock.calls.map(([o]) => o.offset)).toEqual([0, 1000, 2000]);
        expect(plugin.readRecording.mock.calls.every(([o]) => o.length === READ_CHUNK_BYTES)).toBe(true);
        expect(new Uint8Array(await result.arrayBuffer())).toEqual(content);
        expect(result.name).toBe('recording-20261119-120000.wav');
        expect(result.type).toBe('audio/wav');
        // 更新日時は録り終えた時刻（サーバーは「更新日時 − 長さ」を開始日時にする）
        expect(result.lastModified).toBe(Date.parse('2026-11-19T12:00:10+09:00'));
        expect(progress).toEqual([40, 80, 100]);
    });

    it('一覧のときより大きくなっていたら、readRecording の size まで読む', async () => {
        const content = Uint8Array.from({ length: 1500 }, (_, i) => i % 256);
        const plugin = fakePlugin(content, 1000);
        const result = await readRecordingFile(plugin, file(800));
        expect(result.size).toBe(1500);
    });

    it('途中で data が空になったら、そこで止める', async () => {
        const plugin = {
            readRecording: vi.fn(async ({ offset = 0 }) =>
                offset === 0
                    ? { data: toBase64(new Uint8Array([1, 2, 3])), offset, size: 10 }
                    : { data: '', offset, size: 10 },
            ),
        };
        const result = await readRecordingFile(plugin, file(10));
        expect(result.size).toBe(3);
        expect(plugin.readRecording).toHaveBeenCalledTimes(2);
    });

    it('空のファイルは読みに行かない', async () => {
        const plugin = fakePlugin(new Uint8Array(), 1000);
        const result = await readRecordingFile(plugin, file(0));
        expect(result.size).toBe(0);
        expect(plugin.readRecording).not.toHaveBeenCalled();
    });

    it('decodeBase64 は btoa の逆', () => {
        const bytes = new Uint8Array([0, 1, 127, 128, 255]);
        expect(decodeBase64(toBase64(bytes))).toEqual(bytes);
    });
});
