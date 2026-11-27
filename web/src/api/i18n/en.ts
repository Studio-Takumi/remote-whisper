import type { ja } from '@/api/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// API・状態（api/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
