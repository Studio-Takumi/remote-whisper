// Ollama を使う処理ごとのモデル（#178。spec 5.3）
export type OllamaModels = {
    materialTerms: string;
    context: string;
    scope: string;
    transcriptTerms: string;
    liveSummary: string;
    liveTitle: string;
    overview: string;
    detail: string;
    finalTitle: string;
};

// 最終の要約は、全体概要と要約詳細のモデルの組で見る（#178。表示する版の選び方・作り直すか）
export function isCurrentFinalSummary(summary: { model: string; overviewModel?: string }, models: OllamaModels) {
    return summary.model === models.detail && (summary.overviewModel ?? summary.model) === models.overview;
}

// 画面に出す最終の要約のモデル。全体概要と要約詳細が同じなら 1 つだけ
export function finalModelLabel(models: OllamaModels) {
    return models.overview === models.detail ? models.detail : `${models.overview} / ${models.detail}`;
}

// setting.json の中身（docs/spec.md 5.3 節）。後で GET /api/settings から取り、PATCH /api/settings で保存する
export type Settings = {
    version: 1;
    whisper: {
        model: string;
        computeType: string;
        beamSize: number;
        partialIntervalSec: number;
        silenceMs: number;
        maxSegmentSec: number;
        unloadAfterMin: number;
        // 話しているかの判定。auto は音の大きさをそろえてから VAD で判定する。manual は speechDbfs より大きい音を話し声とみなす
        speechThreshold: 'auto' | 'manual';
        speechDbfs: number;
        // 録音を終えたら録音全体から最終の文字起こしを作るか・話者を分けるか（#121。古いサーバーにはない）
        finalTranscript?: boolean;
        diarize?: boolean;
    };
    ollama: {
        host: string;
        // 処理ごとのモデル（#178）
        models: OllamaModels;
        liveSummaryIntervalMin: number;
        keepAliveMin: number;
        // 要約度（要約の細かさ。1〜5、既定は 3）。途中の要約・最終の要約の概要・最終の要約の詳細
        liveSummaryDensity: number;
        overviewDensity: number;
        detailDensity: number;
        // 録音中に文字起こしから用語を拾うか（既定はオフ）。オンでも、プロジェクトの pickTerms がオフなら拾わない
        pickTerms: boolean;
    };
    recording: {
        maxConcurrent: number;
        // 接続が切れてから、つながり直すのを待つ時間（分）。過ぎたら途中で終わったことになる
        resumeTimeoutMin: number;
        // ブラウザのマイクの処理（getUserMedia の制約）。録音を始めるときに使う
        noiseSuppression: boolean;
        autoGainControl: boolean;
        echoCancellation: boolean;
    };
    retentionDays: {
        recording: number;
        transcript: number;
        summary: number;
        contextSet: number;
    };
    materials: {
        roots: string[];
        extensions: string[];
    };
    display: {
        // 左メニューのセッションに、録音日時と長さを出すか
        sessionMeta: boolean;
        // 文字起こしのタブに、録音中に拾った用語を出すか。拾うか（ollama.pickTerms）とは別で、オフでも hotwords には使う
        showPickedTerms: boolean;
        // 最終の文字起こしに、話者（「話者 1」など）と世代の選択肢の話者の数を出すか。保存するファイルは変えない
        showSpeakers: boolean;
    };
    // サイドバーのプロジェクトの並び順（プロジェクト ID。#173）。ここにないものは先頭。
    // 一覧（GET /api/projects）はこの順で返ってくる。変えるのは並び替えのときだけ（changeSettings は送らない）
    projectOrder: string[];
};

export const defaultSettings: Settings = {
    version: 1,
    whisper: {
        model: 'large-v3-turbo',
        computeType: 'float16',
        beamSize: 5,
        partialIntervalSec: 1.0,
        silenceMs: 600,
        maxSegmentSec: 25,
        unloadAfterMin: 10,
        speechThreshold: 'auto',
        speechDbfs: -40,
        finalTranscript: true,
        diarize: true,
    },
    ollama: {
        host: 'http://localhost:11434',
        models: {
            materialTerms: 'qwen3.5:2b',
            context: 'qwen3.5:4b',
            scope: 'qwen3.5:4b',
            transcriptTerms: 'qwen3.5:2b',
            liveSummary: 'qwen3.5:2b',
            liveTitle: 'qwen3.5:2b',
            overview: 'qwen3.5:4b',
            detail: 'qwen3.5:4b',
            finalTitle: 'qwen3.5:0.8b',
        },
        liveSummaryIntervalMin: 5,
        keepAliveMin: 10,
        liveSummaryDensity: 3,
        overviewDensity: 3,
        detailDensity: 3,
        pickTerms: false,
    },
    recording: {
        maxConcurrent: 1,
        resumeTimeoutMin: 10,
        noiseSuppression: true,
        autoGainControl: true,
        echoCancellation: true,
    },
    retentionDays: {
        recording: 10,
        transcript: 30,
        summary: 30,
        contextSet: 0,
    },
    materials: {
        roots: ['D:\\work'],
        extensions: ['.md', '.txt', '.pdf', '.html'],
    },
    display: {
        sessionMeta: false,
        showPickedTerms: false,
        showSpeakers: false,
    },
    projectOrder: [],
};

// 設定モーダルのページ（URL の /settings/<ページ>。#177）。最初のものが既定
export const SETTINGS_PAGES = ['whisper', 'models', 'ollama', 'storage', 'materials', 'display'];

// おすすめのモデル（#179。「おすすめに戻す」と、モデルの横の表示）。サーバーの既定値と同じ
export const recommendedModels: OllamaModels = defaultSettings.ollama.models;
export const recommendedWhisperModel = defaultSettings.whisper.model;
