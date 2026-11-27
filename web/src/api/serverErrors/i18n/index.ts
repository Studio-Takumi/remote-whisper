import { en } from '@/api/serverErrors/i18n/en';
import { ja } from '@/api/serverErrors/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// サーバーのエラーの辞書。引くのは serverErrors.ts（コードから文にする）だけ
export const serverErrorMessages = defineMessages({ ja, en });
