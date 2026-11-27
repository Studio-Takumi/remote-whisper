import { en } from '@/features/setup/i18n/en';
import { ja } from '@/features/setup/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// セットアップ（features/setup/）の辞書。部品では useT(setupMessages)、React の外では setupMessages.t で引く
export const setupMessages = defineMessages({ ja, en });
