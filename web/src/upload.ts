// 音声ファイルのアップロード（#180。POST /api/projects/{pid}/sessions/upload）。
// 進み具合を出すため、fetch ではなく XMLHttpRequest で送る。本文はファイルそのもの
import type { SessionJson } from '@/api';
import { apiUrl } from '@/endpoint';

// 選べるファイル。動画は音声だけを使う
export const AUDIO_ACCEPT = 'audio/*,video/*,.m4a,.mp3,.wav,.flac,.ogg,.opus,.webm,.aac';

export function uploadUrl(projectId: string, file: { name: string; lastModified: number }) {
    const params = new URLSearchParams({ name: file.name, lastModified: String(file.lastModified) });
    return apiUrl(`/api/projects/${encodeURIComponent(projectId)}/sessions/upload?${params}`);
}

// サーバーの断った理由（detail）。読めなければ状態コード
export function uploadError(status: number, body: string) {
    try {
        const detail = (JSON.parse(body) as { detail?: unknown }).detail;
        if (typeof detail === 'string') {
            return detail;
        }
    } catch {
        // JSON でなければ下へ
    }
    return status === 0 ? 'アップロードが途中で切れました' : `ホストが受け付けませんでした（${status}）`;
}

// percent は 0〜100。作ったセッションを返す
export function uploadAudio(
    projectId: string,
    file: File,
    onProgress: (percent: number) => void,
): Promise<SessionJson> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl(projectId, file));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onProgress(Math.floor((e.loaded / e.total) * 100));
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText) as SessionJson);
            } else {
                reject(new Error(uploadError(xhr.status, xhr.responseText)));
            }
        };
        xhr.onerror = () => reject(new Error(uploadError(0, '')));
        xhr.send(file);
    });
}
