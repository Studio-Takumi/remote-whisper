import { en } from '@/features/projects/i18n/en';
import { ja } from '@/features/projects/i18n/ja';
import { defineMessages } from '@/i18n/messages';

// プロジェクト（features/projects/）の辞書。部品では useT(projectsMessages)、React の外では projectsMessages.t で引く
export const projectsMessages = defineMessages({ ja, en });
