import { en } from '@/features/session/i18n/en';
import { ja } from '@/features/session/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// セッション（features/session/）の辞書。部品では useT(sessionMessages)、React の外では sessionMessages.t で引く
export const sessionMessages = defineMessages({ ja, en });
