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
        // 話しているとみなす音量。auto は周りの音量に合わせて変える。manual は speechDbfs を使う
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
    };
    recording: {
        maxConcurrent: number;
        // ブラウザのマイクの処理（getUserMedia の制約）。録音を始めるときに使う
        noiseSuppression: boolean;
        autoGainControl: boolean;
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
        liveSummaryIntervalMin: 3,
        keepAliveMin: 10,
    },
    recording: {
        maxConcurrent: 1,
        noiseSuppression: true,
        autoGainControl: true,
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
};
