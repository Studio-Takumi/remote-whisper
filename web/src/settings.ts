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
    };
    ollama: {
        host: string;
        liveSummaryModel: string;
        finalSummaryModel: string;
        contextModel: string;
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
    };
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
    },
    ollama: {
        host: 'http://localhost:11434',
        liveSummaryModel: 'qwen3.5:4b',
        finalSummaryModel: 'qwen3.5:4b',
        contextModel: 'qwen3.5:4b',
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
    },
};
