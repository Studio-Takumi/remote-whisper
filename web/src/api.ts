// サーバーの REST API（docs/spec.md 7.1 節）を呼ぶ

// サーバーがエラー（4xx・5xx）を返したとき。message はサーバーの detail（日本語）
export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await fetch(path, {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, 'サーバーにつながりません');
    }
    if (!res.ok) {
        let message = `${method} ${path}: ${res.status}`;
        try {
            const detail = (await res.json()).detail;
            if (typeof detail === 'string') {
                message = detail;
            }
        } catch {
            // 本文が JSON でなければ、ステータスだけ
        }
        throw new ApiError(res.status, message);
    }
    return res.json() as Promise<T>;
}

export const api = {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};

// --- 返ってくるものの型 ---

export type ProjectJson = {
    id: string;
    name: string;
    path: string;
    selection: { contextSet: string | null; useHotwords: boolean; useContext: boolean };
};

// どのファイルが残っているか。保存期間を過ぎて消えたものは「期限切れ」と出す
export type SessionFiles = { recording: boolean; transcript: boolean; summaries: number; liveSummary: boolean };

export type SessionJson = {
    id: string;
    title: string | null;
    status: 'recording' | 'done' | 'interrupted';
    startedAt: string;
    endedAt: string | null;
    // 録音の長さ（秒）。録音中と、これを記録する前のセッションは null
    durationSec?: number | null;
    contextSet: string | null;
    // 最終の要約を作れなかった（spec 6.7）。作り直して作れたら false に戻る
    summaryFailed?: boolean;
    files: SessionFiles;
};

export type TranscriptJson = { lines: { time: string; text: string }[] };

export type SummaryInfoJson = {
    generationId: string;
    model: string;
    think: boolean;
    generatedAt: string;
    title: string | null;
};

export type SummaryJson = ({ kind: 'final'; text: string } & SummaryInfoJson) | { kind: 'live'; text: string };

export type DirEntry = { name: string; path: string };
export type DirListing = { path: string | null; parent: string | null; dirs: DirEntry[]; files: DirEntry[] };
