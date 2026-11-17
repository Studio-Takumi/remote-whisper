import { describe, expect, it } from 'vitest';

import { type Settings, defaultSettings } from '@/features/settings/settings';
import { cleanForSave, keepLocked } from '@/features/settings/settingsDraft';

describe('keepLocked', () => {
    it('録音中に変えられない項目だけ、今の設定の値に戻す', () => {
        const draft: Settings = {
            ...defaultSettings,
            whisper: { ...defaultSettings.whisper, model: 'small', silenceMs: 900, beamSize: 3 },
            recording: { ...defaultSettings.recording, noiseSuppression: false, maxConcurrent: 2 },
        };
        const kept = keepLocked(draft, defaultSettings);
        expect(kept.whisper.model).toBe(defaultSettings.whisper.model);
        expect(kept.whisper.silenceMs).toBe(defaultSettings.whisper.silenceMs);
        expect(kept.whisper.beamSize).toBe(3);
        expect(kept.recording.noiseSuppression).toBe(defaultSettings.recording.noiseSuppression);
        expect(kept.recording.maxConcurrent).toBe(2);
    });
});

describe('cleanForSave', () => {
    it('フォルダと拡張子の空要素を落とし、拡張子の先頭の . をそろえる', () => {
        const saved = cleanForSave({
            ...defaultSettings,
            materials: { ...defaultSettings.materials, roots: [' D:\\a ', ''], extensions: ['pdf', ' ', ' .md '] },
        });
        expect(saved.materials.roots).toEqual(['D:\\a']);
        expect(saved.materials.extensions).toEqual(['.pdf', '.md']);
    });

    it('開ける名前の空要素を落とす。network がなければ足さない', () => {
        expect(
            cleanForSave({ ...defaultSettings, network: { allowedHosts: [' a.example.com', ' '] } }).network,
        ).toEqual({ allowedHosts: ['a.example.com'] });
        expect(cleanForSave({ ...defaultSettings, network: undefined }).network).toBeUndefined();
    });
});
