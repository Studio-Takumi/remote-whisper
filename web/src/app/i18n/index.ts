import { en } from '@/app/i18n/en';
import { ja } from '@/app/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// アプリの枠（app/）の辞書。部品では useT(appMessages)、React の外では appMessages.t で引く
export const appMessages = defineMessages({ ja, en });
