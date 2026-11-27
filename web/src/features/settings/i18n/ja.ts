import type { Dictionary } from '@/i18n/messages';

// 設定（features/settings/）の文（日本語）。キーは「部品の名前.役割」（web/README.md の「表示言語（i18n）」）
export const ja = {
    'languageRow.label': '表示言語',
} as const satisfies Dictionary;
