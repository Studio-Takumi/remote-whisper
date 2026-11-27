import type { ja } from '@/features/materials/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 参考資料（features/materials/）の文（英語）。まだ訳していないキーは省く（日本語の文を出す）
export const en = defineTranslation<typeof ja>()({});
