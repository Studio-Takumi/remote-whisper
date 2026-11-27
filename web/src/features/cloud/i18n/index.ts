import { en } from '@/features/cloud/i18n/en';
import { ja } from '@/features/cloud/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// クラウド版（features/cloud/）の辞書。部品では useT(cloudMessages)、React の外では cloudMessages.t で引く
export const cloudMessages = defineMessages({ ja, en });
