// デモ版（demo ブランチのビルド）で、データを変える操作を止める（#414。spec/demo.md）。
// ?demo（説明用のスクリーンショット）では止めない（手元だけで動かして撮るため）
import { toast } from 'sonner';

import { isDemoBuild } from '@/api/demoBuild';

// 止める操作と、文言に入れる「〜すること」。ほかの Issue で止める操作を足すときも、ここに足す
export const DEMO_ACTIONS = {
    createProject: '新たにプロジェクトを作成すること',
    newSession: '新たにセッションを作成すること',
    record: '録音すること',
    upload: '音声ファイルをアップロードすること',
    moveSession: 'セッションを移動すること',
    reorderProjects: 'プロジェクトを並べ替えること',
    regenerateSummary: '要約を再生成すること',
    regenerateFinalTranscript: '浄書済み文字起こしを再生成すること',
    correct: '文字起こしを修正すること',
    terms: '用語リストを変更すること',
    contextSet: '参考資料を変更すること',
    settings: '設定を変更すること',
    push: '通知を設定すること',
    copy: 'コピーすること',
} as const;

export type DemoAction = keyof typeof DEMO_ACTIONS;

// 止めたときの文言（「デモ版のため〜はできません」）
export function demoRefusal(action: DemoAction) {
    return `デモ版のため${DEMO_ACTIONS[action]}はできません`;
}

// デモ版なら、止めた理由をトーストで出して true を返す。呼ぶ側は true なら何もしないで戻る
export function blockInDemo(action: DemoAction): boolean {
    if (!isDemoBuild) {
        return false;
    }
    const message = demoRefusal(action);
    // 何度押しても 1 つだけ出す
    toast.info(message, { id: message });
    return true;
}
