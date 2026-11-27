import { en } from '@/api/i18n/en';
import { ja } from '@/api/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// API・状態（api/）の辞書。部品では useT(apiMessages)、React の外では apiMessages.t で引く
export const apiMessages = defineMessages({ ja, en });
