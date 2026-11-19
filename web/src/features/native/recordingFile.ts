// iOS アプリで録ったファイルを、web の File にする（spec/mobile.md 11.3 の「ファイルを web に渡す方法」）。
// 一度に全部読むとブリッジとメモリが詰まるので、readRecording で 4MiB ずつ base64 で読んでつなぐ
import type { RecorderPlugin, RecordingFile } from '@/features/native/recorderTypes';

// readRecording の length の上限（4MiB）
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// onProgress は 0〜100（読んだ分）
export async function readRecordingFile(
    plugin: Pick<RecorderPlugin, 'readRecording'>,
    file: RecordingFile,
    onProgress?: (percent: number) => void,
): Promise<File> {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    let size = file.size;
    while (offset < size) {
        const chunk = await plugin.readRecording({ name: file.name, offset, length: READ_CHUNK_BYTES });
        // 頼んだ位置と違うところを返したら、つなぐと壊れるので止める（ネイティブ側の不具合に気づけるように）
        if (chunk.offset !== offset) {
            throw Object.assign(new Error(`readRecording returned offset ${chunk.offset}, expected ${offset}`), {
                code: 'io',
            });
        }
        const bytes = decodeBase64(chunk.data);
        // 終わりを越えたら data は空。読んでいる間に小さくなっても止まる
        if (bytes.length === 0) {
            break;
        }
        parts.push(bytes);
        offset += bytes.length;
        size = chunk.size;
        onProgress?.(size > 0 ? Math.min(100, Math.floor((offset / size) * 100)) : 100);
    }
    // 更新日時は録り終えた時刻。サーバーは「更新日時 − 長さ」を開始日時にする（spec/flows.md 6.11）
    const lastModified = Date.parse(file.modifiedAt);
    return new File(parts, file.name, {
        type: 'audio/wav',
        lastModified: Number.isNaN(lastModified) ? Date.now() : lastModified,
    });
}
