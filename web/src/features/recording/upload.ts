// 音声ファイルのアップロード（#180。POST /api/projects/{pid}/sessions/upload）。
// 進み具合を出すため、fetch ではなく XMLHttpRequest で送る。本文はファイルそのもの
import type { SessionJson } from '@/api/api';
import { appAccessToken, appAuthActive, isRelayUrl } from '@/api/appAuth';
import { apiUrl } from '@/api/endpoint';
import { recordingMessages } from '@/features/recording/i18n';
import type { TranscriptionLanguage } from '@/features/settings/settings';
import { type Language, getLanguage } from '@/i18n/language';

// 選べるファイル。動画は音声だけを使う
export const AUDIO_ACCEPT = 'audio/*,video/*,.m4a,.mp3,.wav,.flac,.ogg,.opus,.webm,.aac';

// sources は複数のファイルを 1 つのセッションにまとめるときのファイルの数（#241・#357。1 つ目のファイルに付ける）。
// language は今回だけ変えた文字起こしの言語（#482）。省くと全体設定。
// displayLanguage はこの端末の表示言語（#498。未設定の文字起こしの言語と「表示言語に合わせる」要約の言語に使う）
export function uploadUrl(
    projectId: string,
    file: { name: string; lastModified: number },
    sources?: number,
    language?: TranscriptionLanguage | null,
    displayLanguage: Language = getLanguage(),
) {
    const params = new URLSearchParams({ name: file.name, lastModified: String(file.lastModified) });
    if (sources !== undefined) {
        params.set('sources', String(sources));
    }
    if (language) {
        params.set('language', language);
    }
    params.set('displayLanguage', displayLanguage);
    return apiUrl(`/api/projects/${encodeURIComponent(projectId)}/sessions/upload?${params}`);
}

// まとめるセッションに、2 つ目以降のファイル（ほかの音源）を足す（POST .../sources/upload）
export function sourceUploadUrl(projectId: string, sessionId: string, file: { name: string; lastModified: number }) {
    const params = new URLSearchParams({ name: file.name, lastModified: String(file.lastModified) });
    return apiUrl(
        `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/sources/upload?${params}`,
    );
}

// 送れなかった。status はサーバーの状態コード（つながらなければ 0）
export class UploadError extends Error {
    readonly status: number;
    constructor(status: number, body: string) {
        super(uploadError(status, body));
        this.status = status;
    }
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
    return status === 0 ? recordingMessages.t('upload.cutOff') : recordingMessages.t('upload.rejected', { status });
}

// percent は 0〜100。作ったセッションを返す
export function uploadAudio(
    projectId: string,
    file: File,
    onProgress: (percent: number) => void,
    sources?: number,
    language?: TranscriptionLanguage | null,
): Promise<SessionJson> {
    return sendFile<SessionJson>(uploadUrl(projectId, file, sources, language), file, onProgress);
}

// まとめるセッションに、ほかの音源のファイルを足す。足した音源（id・name）を返す
export function uploadSource(
    projectId: string,
    sessionId: string,
    file: File,
    onProgress: (percent: number) => void,
): Promise<{ id: number; name: string }> {
    return sendFile(sourceUploadUrl(projectId, sessionId, file), file, onProgress);
}

// アプリの中のクラウド版で、送り先が中間サーバーなら、アプリのトークンを取ってから送る（#441）。ほかは今まで通りすぐ送る
function sendFile<T>(url: string, file: File, onProgress: (percent: number) => void): Promise<T> {
    if (appAuthActive && isRelayUrl(url)) {
        return appAccessToken().then((token) => sendWith<T>(url, file, onProgress, token));
    }
    return sendWith<T>(url, file, onProgress, null);
}

function sendWith<T>(url: string, file: File, onProgress: (percent: number) => void, token: string | null): Promise<T> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onProgress(Math.floor((e.loaded / e.total) * 100));
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText) as T);
            } else {
                reject(new UploadError(xhr.status, xhr.responseText));
            }
        };
        xhr.onerror = () => reject(new UploadError(0, ''));
        xhr.send(file);
    });
}
