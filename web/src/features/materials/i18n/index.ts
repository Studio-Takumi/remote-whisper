import { en } from '@/features/materials/i18n/en';
import { ja } from '@/features/materials/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// 参考資料（features/materials/）の辞書。部品では useT(materialsMessages)、React の外では materialsMessages.t で引く
export const materialsMessages = defineMessages({ ja, en });
