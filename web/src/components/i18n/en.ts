import type { ja } from '@/components/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 共通部品（components/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
