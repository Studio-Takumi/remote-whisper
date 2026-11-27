import { useState } from 'react';

import { toast } from 'sonner';

import { Switch } from '@/components/ui/switch';
import { Row } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import { disablePush, enablePush, pushEnabled, pushSupport, pushSupportMessage } from '@/features/settings/push';
import { useT } from '@/i18n/messages';

// 「最終要約の通知」（#245）。端末ごとの設定で、全体設定の保存とは別に、切り替えたときに効く。
// オンにしたときにだけブラウザの許可を求める（設定を開いただけでは求めない）
export function PushToggle() {
    const t = useT(settingsMessages);
    const [on, setOn] = useState(pushEnabled);
    const [busy, setBusy] = useState(false);
    const support = pushSupport();
    const unavailable = support === 'ok' ? null : pushSupportMessage(support);

    async function change(next: boolean) {
        setBusy(true);
        try {
            if (next) {
                await enablePush();
                toast.success(t('pushToggle.enabled'));
            } else {
                await disablePush();
            }
            setOn(next);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('pushToggle.failed'));
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
            label={t('pushToggle.label')}
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
