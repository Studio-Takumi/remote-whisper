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
