import type { MicState } from '@/features/recording/audio/microphone';

// 音は届いているのに文字起こしが出ないとき（#120）。録音は続いている（音声はサーバーに保存されている）
export const stalledMessage =
    '音は届いていますが、文字起こしが出ていません（録音は続いています）。設定の「ブラウザのエコー除去」「ブラウザの雑音抑制」を切ると直ることがあります';

// マイクが止まったときの知らせ（#102）
export function micStateMessage(state: MicState) {
    switch (state) {
        case 'ended':
            return 'マイクが止まりました。録音されていません。「マイクを開き直す」を押してください';
        case 'muted':
            return 'マイクの音が届いていません（ほかのアプリや OS がマイクを止めています）。録音されていません';
        case 'suspended':
            return '音声の処理が止まりました（電話や通知などのため）。「マイクを開き直す」を押してください';
        default:
            return '';
    }
}
