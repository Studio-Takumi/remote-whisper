import { en } from '@/features/native/i18n/en';
import { ja } from '@/features/native/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// アプリ（ネイティブ）（features/native/）の辞書。部品では useT(nativeMessages)、React の外では nativeMessages.t で引く
export const nativeMessages = defineMessages({ ja, en });
