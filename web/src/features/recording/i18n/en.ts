import type { ja } from '@/features/recording/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 録音（features/recording/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
