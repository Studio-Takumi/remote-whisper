// デモ版（#415）の設定の画面で、変えられるもの（表示の設定）と、その保存。spec/demo.md
import type { Settings } from '@/features/settings/settings';

// 変えられるのは、表示の設定のうちこの 3 つ（テーマは端末ごとの設定で、もともと全体設定の保存とは別）。
// マイクのショートカットは、録音できないので変えられない
const DISPLAY_KEYS = ['sessionMeta', 'showPickedTerms', 'showSpeakers'] as const;

type DemoDisplay = Partial<Pick<Settings['display'], (typeof DISPLAY_KEYS)[number]>>;

// 端末の中（localStorage）の置き場。サーバーはないので、全体設定ではなくこの端末だけに残る
export const DEMO_DISPLAY_KEY = 'rw-demo-display';

// 設定の欄の一部（update の引数）を変えてよいか
export function editableInDemo(section: string, patch: object): boolean {
    return (
        section === 'display' && Object.keys(patch).every((key) => (DISPLAY_KEYS as readonly string[]).includes(key))
    );
}

function stored(): DemoDisplay {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(DEMO_DISPLAY_KEY) ?? '{}');
        return value !== null && typeof value === 'object' ? pickDisplay(value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// 変えられる 3 つだけを、真偽値のものから取る
function pickDisplay(display: Record<string, unknown>): DemoDisplay {
    return Object.fromEntries(
        DISPLAY_KEYS.filter((key) => typeof display[key] === 'boolean').map((k) => [k, display[k]]),
    );
}

// 同梱した設定に、この端末で変えた表示の設定を重ねる
export function withStoredDisplay(settings: Settings): Settings {
    return { ...settings, display: { ...settings.display, ...stored() } };
}

// 設定の画面で保存した表示の設定を、この端末に残して、設定に重ねたものを返す。ほかの項目は今のまま
export function saveDisplay(current: Settings, next: Settings): Settings {
    const display = pickDisplay(next.display);
    try {
        localStorage.setItem(DEMO_DISPLAY_KEY, JSON.stringify({ ...stored(), ...display }));
    } catch {
        // 保存できなくても、このタブの中では変えたままにする
    }
    return { ...current, display: { ...current.display, ...display } };
}
