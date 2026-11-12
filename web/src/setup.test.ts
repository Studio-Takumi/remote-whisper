import { describe, expect, it } from 'vitest';

import { SETTINGS_PAGES } from '@/settings';
import {
    type SetupStatus,
    formatElapsed,
    hasMissing,
    isBusy,
    missingSizeGb,
    missingSteps,
    normalizeSetup,
    pullPercent,
    shouldAutoOpen,
} from '@/setup';

function status(patch: Partial<SetupStatus> = {}): SetupStatus {
    return {
        runtime: 'windows-bundle',
        remote: false,
        recording: false,
        gpu: 'nvidia',
        llm: {
            backend: 'ollama',
            running: true,
            found: true,
            unauthorized: false,
            downloadUrl: 'https://ollama.com/download',
            models: [
                { name: 'qwen3.5:2b', sizeGb: 3.1, installed: true },
                { name: 'qwen3.5:4b', sizeGb: 4.0, installed: true },
            ],
            pull: null,
            pullCancellable: true,
        },
        whisperx: {
            installed: true,
            installable: true,
            downloadGb: 3.5,
            diskGb: 6,
            minutes: [10, 30],
            command: null,
            install: null,
        },
        hfToken: { source: 'file' },
        ...patch,
    };
}

const on = { whisper: { finalTranscript: true, diarize: true } } as const;

describe('missingSteps', () => {
    it('reports nothing when everything is ready', () => {
        expect(hasMissing(status(), on)).toBe(false);
    });

    it('counts missing models and their size', () => {
        const s = status();
        s.llm.models[1].installed = false;
        s.llm.models.push({ name: 'qwen3.5:0.8b', sizeGb: 1.2, installed: false });
        expect(missingSteps(s, on).models).toBe(true);
        expect(missingSizeGb(s)).toBe(5.2);
    });

    it('treats models as missing when Ollama is down', () => {
        const s = status();
        s.llm.running = false;
        expect(missingSteps(s, on)).toMatchObject({ llm: true, models: true });
    });

    it('does not count models of unknown size (LM Studio)', () => {
        const s = status();
        s.llm.backend = 'lmstudio';
        s.llm.models = [
            { name: 'google/gemma-4-e4b', sizeGb: 6.3, installed: false },
            { name: 'qwen/qwen3.5-2b', sizeGb: null, installed: false },
        ];
        expect(missingSizeGb(s)).toBe(6.3);
        expect(missingSteps(s, on).models).toBe(true);
    });

    it('skips WhisperX and the token when the final transcript is off', () => {
        const s = status({ hfToken: { source: null } });
        s.whisperx.installed = false;
        const off = { whisper: { finalTranscript: false, diarize: true } };
        expect(missingSteps(s, off)).toMatchObject({ whisperx: false, token: false });
        expect(missingSteps(s, on)).toMatchObject({ whisperx: true, token: false });
    });

    it('needs the token only with WhisperX and diarization on', () => {
        const s = status({ hfToken: { source: null } });
        expect(missingSteps(s, on).token).toBe(true);
        expect(missingSteps(s, { whisper: { finalTranscript: true, diarize: false } }).token).toBe(false);
        expect(missingSteps(status({ hfToken: { source: 'env' } }), on).token).toBe(false);
    });
});

describe('shouldAutoOpen', () => {
    const missing = () => status({ hfToken: { source: null } });

    it('opens on the host when something is missing and not dismissed', () => {
        expect(shouldAutoOpen(missing(), on, { cloud: false, dismissed: false })).toBe(true);
    });

    it('does not open when dismissed, in the cloud, through the tunnel, or when ready', () => {
        expect(shouldAutoOpen(missing(), on, { cloud: false, dismissed: true })).toBe(false);
        expect(shouldAutoOpen(missing(), on, { cloud: true, dismissed: false })).toBe(false);
        expect(shouldAutoOpen({ ...missing(), remote: true }, on, { cloud: false, dismissed: false })).toBe(false);
        expect(shouldAutoOpen(status(), on, { cloud: false, dismissed: false })).toBe(false);
    });
});

describe('progress', () => {
    it('is busy while pulling or installing', () => {
        const s = status();
        expect(isBusy(s)).toBe(false);
        s.llm.pull = {
            state: 'running',
            backend: 'ollama',
            models: ['qwen3.5:2b'],
            model: 'qwen3.5:2b',
            index: 0,
            completed: 1,
            total: 4,
            error: null,
        };
        expect(isBusy(s)).toBe(true);
        expect(pullPercent(s.llm.pull)).toBe(25);
        s.llm.pull.state = 'done';
        s.whisperx.install = {
            state: 'running',
            phase: 'downloading',
            package: 'torch',
            collected: 3,
            rolledBack: false,
            rollbackFailed: false,
            elapsedSec: 75,
        };
        expect(isBusy(s)).toBe(true);
    });

    it('formats the elapsed time and handles an unknown total', () => {
        expect(formatElapsed(75)).toBe('1 分 15 秒');
        expect(formatElapsed(9)).toBe('9 秒');
        expect(
            pullPercent({
                state: 'running',
                backend: 'lmstudio',
                models: [],
                model: '',
                index: 0,
                completed: 5,
                total: 0,
                error: null,
            }),
        ).toBe(0);
    });
});

describe('normalizeSetup', () => {
    it('reads the old shape (ollama instead of llm) from older hosts', () => {
        const { llm, ...rest } = status();
        const { backend: _b, unauthorized: _u, pullCancellable: _p, ...ollama } = llm;
        const pull = {
            state: 'running',
            models: ['qwen3.5:2b'],
            model: 'qwen3.5:2b',
            index: 0,
            completed: 1,
            total: 4,
            error: null,
        };
        const old = { ...rest, ollama: { ...ollama, running: false, pull } } as unknown as SetupStatus;
        const s = normalizeSetup(old);
        expect(s.llm).toMatchObject({ backend: 'ollama', running: false, unauthorized: false, pullCancellable: true });
        expect(s.llm.pull?.backend).toBe('ollama');
        expect(missingSteps(s, on)).toMatchObject({ llm: true, models: true });
        expect(isBusy(s)).toBe(true);
    });

    it('leaves the new shape as it is', () => {
        const s = status();
        expect(normalizeSetup(s)).toBe(s);
    });
});

it('has a setup page in the settings', () => {
    expect(SETTINGS_PAGES.at(-1)).toBe('setup');
});
