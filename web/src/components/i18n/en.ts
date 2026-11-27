import type { ja } from '@/components/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 共通部品（components/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // copyMarkdown.ts
    'copyMarkdown.failed': "Couldn't copy",

    // markdownImages.ts
    'markdownImages.image': 'Image: {href}',
});
