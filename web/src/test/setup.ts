import { setLanguage } from '@/i18n/language';

// テストは日本語の文で確かめる。jsdom のブラウザの言語（en-US）で英語にならないよう、表示言語を ja にしておく（#487）
setLanguage('ja');
