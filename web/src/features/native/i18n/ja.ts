import { defineDictionary } from '@/i18n/messages';

// アプリ（ネイティブ。features/native/）の文（日本語）。キーは「ファイル名.役割」（web/README.md の「表示言語（i18n）」）
export const ja = defineDictionary({
    'appEndpointSetup.change': '変える',
    'appEndpointSetup.connect': 'つなぐ',
    'appEndpointSetup.hostAddress': '接続先',
    'appEndpointSetup.intro':
        '文字起こしをするホストの URL を入れてください。この端末に保存し、次からはそのまま開きます。',
    'appEndpointSetup.saveFailed': '保存できませんでした',
    'appEndpointSetup.urlInvalid': 'ホストの URL（例: https://pc.example.ts.net）を入れてください。パスは付けません',
    'appEndpointSetup.urlLabel': 'ホストの URL',
});
