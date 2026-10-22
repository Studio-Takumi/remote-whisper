import { useState } from 'react';

import { toast } from 'sonner';

import { Row } from '@/components/SettingsParts';
import { Switch } from '@/components/ui/switch';
import { disablePush, enablePush, pushEnabled, pushSupport, pushSupportMessage } from '@/push';

// 「最終要約の通知」（#245）。端末ごとの設定で、全体設定の保存とは別に、切り替えたときに効く。
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
            label='最終要約の通知'
            // 説明は使えないときの理由だけ（ほかは公式 HP の使い方で説明する。#239）
            description={
                unavailable ? <span className='text-amber-700 dark:text-amber-400'>{unavailable}</span> : undefined
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
