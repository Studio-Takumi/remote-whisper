import { useState } from 'react';

import { toast } from 'sonner';

import { Row } from '@/components/SettingsParts';
import { Switch } from '@/components/ui/switch';
import { disablePush, enablePush, pushEnabled, pushSupport, pushSupportMessage } from '@/push';

// 「最終要約ができたら通知する」（#245）。端末ごとの設定で、全体設定の保存とは別に、切り替えたときに効く。
// オンにしたときにだけブラウザの許可を求める（設定を開いただけでは求めない）
export function PushToggle() {
    const [on, setOn] = useState(pushEnabled);
    const [busy, setBusy] = useState(false);
    const support = pushSupport();
    const unavailable = support === 'ok' ? null : pushSupportMessage(support);

    async function change(next: boolean) {
        setBusy(true);
        try {
            if (next) {
                await enablePush();
                toast.success('最終要約ができたら、この端末に通知します');
            } else {
                await disablePush();
            }
            setOn(next);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : '通知を設定できませんでした');
            if (!next) {
                // 消せなくても、この端末ではオフにしたことにする（ホストは期限切れで消す）
                setOn(false);
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <Row
            id='push-notify'
            label='最終要約ができたら通知する（この端末）'
            description={
                <>
                    録音を終えたあとと、音声ファイルから作ったときに、最終要約ができたらこの端末に通知する。通知にはセッションのタイトルだけを出す。そのセッションを開いているときは出さない。この端末だけの設定で、保存を押さなくても切り替えたときに効く。iPhone
                    はホーム画面に追加したアプリ（iOS 16.4 以降）でだけ使える
                    {unavailable && (
                        <span className='mt-1 block text-amber-700 dark:text-amber-400'>{unavailable}</span>
                    )}
                </>
            }
        >
            <Switch
                id='push-notify'
                checked={on}
                disabled={busy || (unavailable !== null && !on)}
                onCheckedChange={(next) => void change(next)}
            />
        </Row>
    );
}
