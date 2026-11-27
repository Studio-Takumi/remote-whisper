import { recordingMessages } from '@/features/recording/i18n';

// 録音の状態。一時停止中も録音のセッションは続いているので、設定のロックなどは録音中と同じ扱いにする
export type RecordingState = 'idle' | 'recording' | 'paused';

// 録音中に変えられないもの（#133）と、その理由。ほかのもの（別のセッションを開く・要約のモデルなど）は録音中も変えられる
// 文は読んだ時点の表示言語で引く（定数に固めると、読み込んだときの言語のままになるため）
export const recordingLocks = {
    // 文字起こしのモデル・計算の精度（whisper_worker が読み込み直す間、文字起こしが止まる）
    get whisperModel() {
        return recordingMessages.t('recording.locked');
    },
    // 区切りの設定（無音の長さ・区間の長さ・話し声の判定）
    get segmentation() {
        return recordingMessages.t('recording.locked');
    },
    // ブラウザのマイクの処理
    get microphone() {
        return recordingMessages.t('recording.locked');
    },
    // 参考資料（使うセットは録音を始めたときに決まり、セットの作成は GPU を長く使う）
    get contextSet() {
        return recordingMessages.t('recording.referenceMaterials');
    },
    // ほかのセッションの最終の文字起こし・要約の作り直し（GPU キューは実行中のジョブを止めない）
    get regenerate() {
        return recordingMessages.t('recording.regenerate');
    },
    // ほかのセッションの続きを録音する
    get continueRecording() {
        return recordingMessages.t('recording.continueOther');
    },
};
