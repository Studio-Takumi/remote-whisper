import type { ja } from '@/features/native/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// アプリ（ネイティブ）（features/native/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
