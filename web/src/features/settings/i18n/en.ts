import type { ja } from '@/features/settings/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 設定（features/settings/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
