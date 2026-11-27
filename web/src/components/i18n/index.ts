import { en } from '@/components/i18n/en';
import { ja } from '@/components/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// 共通部品（components/）の辞書。部品では useT(componentsMessages)、React の外では componentsMessages.t で引く
export const componentsMessages = defineMessages({ ja, en });
