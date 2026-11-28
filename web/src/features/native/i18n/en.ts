import type { ja } from '@/features/native/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// アプリ（ネイティブ）（features/native/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    'appEndpointSetup.change': 'Change',
    'appEndpointSetup.connect': 'Connect',
    'appEndpointSetup.hostAddress': 'Host address',
    'appEndpointSetup.intro':
        'Enter the URL of the host that does the transcription. It is saved on this device and opened directly next time.',
    'appEndpointSetup.saveFailed': "Couldn't save",
    'appEndpointSetup.urlInvalid': 'Enter the host URL (e.g. https://pc.example.ts.net), without a path',
    'appEndpointSetup.urlLabel': 'Host URL',
});
