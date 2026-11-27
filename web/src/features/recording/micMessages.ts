import type { MicState } from '@/features/recording/audio/microphone';
import { recordingMessages } from '@/features/recording/i18n';

// 音は届いているのに文字起こしが出ないとき（#120）。録音は続いている（音声はサーバーに保存されている）
export function stalledMessage() {
    return recordingMessages.t('micMessages.stalled');
}

// マイクが止まったときの知らせ（#102）
export function micStateMessage(state: MicState) {
    switch (state) {
        case 'ended':
            return recordingMessages.t('micMessages.ended');
        case 'muted':
            return recordingMessages.t('micMessages.muted');
        case 'suspended':
            return recordingMessages.t('micMessages.suspended');
        default:
            return '';
    }
}

// 選んだマイクがないので、OS に任せて開いたとき（#449）
export function micFallbackMessage(label: string) {
    return label
        ? recordingMessages.t('micMessages.fallbackWithLabel', { label })
        : recordingMessages.t('micMessages.fallback');
}

// 開き直した・切り替えたあとの知らせに、どのマイクで録っているかを添える（#449。内蔵のマイクに変わったことに気づけるように）
export function withMicLabel(message: string, label: string | undefined) {
    return label ? recordingMessages.t('micMessages.withLabel', { message, label }) : message;
}
