import { formatDateTime } from '@/lib/time';

// プロジェクトの一覧・セッションの一覧・参考資料セットの一覧は、画面で見ている部品がなくても、
// ストアが WebSocket の通知で書き換えて使う。既定（5 分）で捨てられないようにする（量は少ない）。
// セッションの中身も、開き直したときに読み込み直さないように捨てない（#361。前はストアに持ち続けていた）
export const KEEP = { gcTime: Infinity } as const;

// 日時（ISO 8601）を画面に出す形にする
export function displayTime(iso: string | null | undefined) {
    return iso ? formatDateTime(new Date(iso)) : undefined;
}
