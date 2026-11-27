import type { ja } from '@/app/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// アプリの枠（app/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
