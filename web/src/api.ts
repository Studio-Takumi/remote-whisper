// サーバーの REST API（docs/spec/api.md 7.1 節）を呼ぶ
import type { Correction } from '@/corrections';
import { apiUrl } from '@/endpoint';

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
        res = await fetch(apiUrl(path), {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, 'ホストにつながりません');
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
    delete: <T>(path: string) => request<T>('DELETE', path),
};

// --- 返ってくるものの型 ---

export type ProjectJson = {
    id: string;
    // 画面の URL に出す ID（#177。古いサーバーにはない）
    uuid?: string;
    name: string;
    path: string;
    // pickTerms は前のサーバーにはない
    selection: { contextSet: string | null; useHotwords: boolean; useContext: boolean; pickTerms?: boolean };
};

// どのファイルが残っているか。保存期間を過ぎて消えたものは「期限切れ」と出す
// finalTranscripts は最終の文字起こしの世代の数（#121。古いサーバーにはない）
export type SessionFiles = {
    recording: boolean;
    transcript: boolean;
    finalTranscripts?: number;
    summaries: number;
    liveSummary: boolean;
};

export type SessionJson = {
    id: string;
    // 画面の URL に出す ID（#177。古いサーバーにはない）
    uuid?: string;
    title: string | null;
    status: 'recording' | 'done' | 'interrupted';
    startedAt: string;
    endedAt: string | null;
    // 録音の長さ（秒）。録音中と、これを記録する前のセッションは null
    durationSec?: number | null;
    contextSet: string | null;
    // 最終の要約を作れなかった（spec/flows.md 6.7）。作り直して作れたら false に戻る
    summaryFailed?: boolean;
    // 音声ファイルをアップロードして作ったセッション（#180）は upload
    source?: 'upload' | null;
    files: SessionFiles;
};

// meta は文字起こしのフロントマター（使うところだけ）
// 今回扱った資料の範囲（#182）。from・to は目次の番号（PDF はページ）で、両端を含む
export type MaterialRange = { file: string; path: string; from: number; to: number };

export type TranscriptJson = {
    lines: { time: string; text: string }[];
    // materialRange は、録音のあとに今回扱った範囲で参考資料を作り直したとき（#182）
    meta?: {
        pickedTerms?: string[];
        manualTerms?: string[];
        materialRange?: MaterialRange[] | null;
        // 置き換え（#176。古いサーバーにはない）
        corrections?: Correction[];
    };
};

// 最終の文字起こし（#121）。meta はフロントマター（使うところだけ）
export type FinalTranscriptJson = {
    lines: { time: string; text: string }[];
    meta: {
        generationId: string;
        model: string;
        generatedAt: string;
        diarization: 'done' | 'off' | 'unavailable';
        speakers: number;
    };
};

// 拾った語を消したときの返事（#103）
export type TermsJson = { pickedTerms: string[]; rejectedTerms: string[]; manualTerms?: string[] };

// 置き換えを足した・外したときの返事（#176）
export type CorrectionsJson = TermsJson & { corrections: Correction[] };

export type SummaryInfoJson = {
    generationId: string;
    // 要約詳細のモデル。overviewModel は全体概要のモデル（#178。古いサーバーにはない）
    model: string;
    overviewModel?: string;
    think: boolean;
    generatedAt: string;
    title: string | null;
};

export type SummaryJson = ({ kind: 'final'; text: string } & SummaryInfoJson) | { kind: 'live'; text: string };

export type DirEntry = { name: string; path: string };
export type DirListing = { path: string | null; parent: string | null; dirs: DirEntry[]; files: DirEntry[] };
