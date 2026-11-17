// 設定のモーダルで編集している下書き（保存するまでサーバーに送らない）
import { type Settings, defaultSettings } from '@/features/settings/settings';

export type LmStudioSettings = NonNullable<Settings['lmstudio']>;
export const defaultLmStudio = defaultSettings.lmstudio as LmStudioSettings;

// 下書きの 1 つの欄（whisper・ollama など）の一部を変える
export type UpdateSection = <K extends Exclude<keyof Settings, 'version'>>(
    section: K,
    patch: Partial<Settings[K]>,
) => void;

// 録音中に変えられない項目（#133・spec/files.md 5.3）は、今の設定の値に戻す。
// 開いている間に録音が始まっても、変えた値を送って断られないように
export function keepLocked(draft: Settings, current: Settings): Settings {
    const { model, computeType, silenceMs, maxSegmentSec, speechThreshold, speechDbfs } = current.whisper;
    const { noiseSuppression, autoGainControl, echoCancellation } = current.recording;
    return {
        ...draft,
        whisper: { ...draft.whisper, model, computeType, silenceMs, maxSegmentSec, speechThreshold, speechDbfs },
        recording: { ...draft.recording, noiseSuppression, autoGainControl, echoCancellation },
    };
}
