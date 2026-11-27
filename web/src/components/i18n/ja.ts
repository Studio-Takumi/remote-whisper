import { defineDictionary } from '@/i18n/messages';

// 共通部品（components/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    // copyMarkdown.ts
    'copyMarkdown.failed': 'コピーできませんでした',

    // markdownImages.ts
    'markdownImages.image': '画像: {href}',
});
