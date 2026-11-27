import { en } from '@/features/recording/i18n/en';
import { ja } from '@/features/recording/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// 録音（features/recording/）の辞書。部品では useT(recordingMessages)、React の外では recordingMessages.t で引く
export const recordingMessages = defineMessages({ ja, en });
