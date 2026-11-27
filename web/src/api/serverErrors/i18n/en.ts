import type { ja } from '@/api/serverErrors/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// サーバーのエラーの文（英語）。まだ訳していないキーは省く（日本語の文を出す。訳は #497）
export const en = defineTranslation<typeof ja>()({});
