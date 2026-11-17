import { describe, expect, it } from 'vitest';

import { pullBlockedReason, pullButtonLabel, pullProgressText } from '@/features/setup/pullModels';
import type { PullJob, SetupStatus } from '@/features/setup/setup';

function status(llm: Partial<SetupStatus['llm']> = {}, recording = false): SetupStatus {
    return {
        runtime: 'dev',
        remote: false,
        recording,
        gpu: 'nvidia',
        hfToken: { source: null },
        whisperx: {
            installed: true,
            installable: true,
            downloadGb: 1,
            diskGb: 1,
            minutes: [1, 2],
            command: null,
            install: null,
        },
        llm: {
            backend: 'ollama',
            running: true,
            found: true,
            unauthorized: false,
            downloadUrl: '',
            models: [],
            pull: null,
            pullCancellable: true,
            ...llm,
        },
    };
}

const pull: PullJob = {
    state: 'running',
    backend: 'ollama',
    models: ['a', 'b'],
    model: 'b',
    index: 1,
    completed: 1.5e9,
    total: 3e9,
    error: null,
};

describe('pullBlockedReason', () => {
    it('LLM が動いていない・録音中なら理由を返す', () => {
        expect(pullBlockedReason(status({ running: false }))).toBe('Ollama が動いてから取得できます');
        expect(pullBlockedReason(status({ backend: 'lmstudio', running: false }))).toBe(
            'LM Studio が動いてから取得できます',
        );
        expect(pullBlockedReason(status({}, true))).toBe('録音が終わってから取得できます');
        expect(pullBlockedReason(status())).toBeNull();
    });
});

describe('pullButtonLabel', () => {
    it('足りないモデルの合計を出し、大きさが分からないものがあれば「以上」を付ける', () => {
        const a = { name: 'a', sizeGb: 2.7, installed: false };
        expect(pullButtonLabel(status({ models: [a] }))).toBe('取得（約 2.7 GB）');
        expect(pullButtonLabel(status({ models: [a, { name: 'b', sizeGb: null, installed: false }] }))).toBe(
            '取得（約 2.7 GB 以上）',
        );
        expect(pullButtonLabel(status({ models: [{ name: 'b', sizeGb: null, installed: false }] }))).toBe('取得');
    });
});

describe('pullProgressText', () => {
    it('何番目を取っているかと、分かれば量を出す', () => {
        expect(pullProgressText(pull, 'ollama')).toBe('b を取得中（2/2）・50%（1.5 GB / 3.0 GB）');
        expect(pullProgressText({ ...pull, total: 0 }, 'ollama')).toBe('b を取得中（2/2）');
    });

    it('取っている先が今の LLM と違えば、先の名前を付ける', () => {
        expect(pullProgressText({ ...pull, total: 0 }, 'lmstudio')).toBe('Ollama で b を取得中（2/2）');
    });
});
