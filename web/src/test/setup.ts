import { setLanguage } from '@/i18n/language';

// テストは日本語の文で確かめる。jsdom のブラウザの言語（en-US）で英語にならないよう、表示言語を ja にしておく（#487）。
// vi.resetModules で読み込み直したとき（localStorage も空にしたとき）も ja になるよう、ブラウザの言語も日本語にする（#497）
Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['ja-JP'] });
Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'ja-JP' });
setLanguage('ja');
