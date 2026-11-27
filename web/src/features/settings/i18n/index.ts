import { en } from '@/features/settings/i18n/en';
import { ja } from '@/features/settings/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// 設定（features/settings/）の辞書。部品では useT(settingsMessages)、React の外では settingsMessages.t で引く
export const settingsMessages = defineMessages({ ja, en });
