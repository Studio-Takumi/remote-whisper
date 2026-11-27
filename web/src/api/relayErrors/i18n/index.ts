import { en } from '@/api/relayErrors/i18n/en';
import { ja } from '@/api/relayErrors/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// 中間サーバー（relay）のエラーの辞書。引くのは api/serverErrors/serverErrors.ts（コードから文にする）だけ
export const relayErrorMessages = defineMessages({ ja, en });
