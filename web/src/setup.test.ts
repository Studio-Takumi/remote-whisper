import { describe, expect, it } from 'vitest';

import { SETTINGS_PAGES } from '@/settings';
import {
    type SetupStatus,
    formatElapsed,
    hasMissing,
    isBusy,
    missingSizeGb,
    missingSteps,
    pullPercent,
    shouldAutoOpen,
} from '@/setup';

function status(patch: Partial<SetupStatus> = {}): SetupStatus {
    return {
        runtime: 'windows-bundle',
        remote: false,
        recording: false,
        gpu: 'nvidia',
        ollama: {
            running: true,
            found: true,
            downloadUrl: 'https://ollama.com/download',
            models: [
                { name: 'qwen3.5:2b', sizeGb: 3.1, installed: true },
                { name: 'qwen3.5:4b', sizeGb: 4.0, installed: true },
            ],
            pull: null,
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
        s.ollama.models[1].installed = false;
        s.ollama.models.push({ name: 'qwen3.5:0.8b', sizeGb: 1.2, installed: false });
        expect(missingSteps(s, on).models).toBe(true);
        expect(missingSizeGb(s)).toBe(5.2);
    });

    it('treats models as missing when Ollama is down', () => {
        const s = status();
        s.ollama.running = false;
        expect(missingSteps(s, on)).toMatchObject({ ollama: true, models: true });
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
        s.ollama.pull = {
            state: 'running',
            models: ['qwen3.5:2b'],
            model: 'qwen3.5:2b',
            index: 0,
            completed: 1,
            total: 4,
            error: null,
        };
        expect(isBusy(s)).toBe(true);
        expect(pullPercent(s.ollama.pull)).toBe(25);
        s.ollama.pull.state = 'done';
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
            pullPercent({ state: 'running', models: [], model: '', index: 0, completed: 5, total: 0, error: null }),
        ).toBe(0);
    });
});

it('has a setup page in the settings', () => {
    expect(SETTINGS_PAGES.at(-1)).toBe('setup');
});
