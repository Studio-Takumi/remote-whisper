// 初回の同意の画面（#162）。利用規約・プライバシーポリシーへの同意。
// データ収集は同意と一緒に許可として記録し、ここでは知らせるだけ（変える画面は置かない）
import { useState } from 'react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { type Me, canSubmitConsent, fetchMe, postConsent, useAccountStore } from '@/features/cloud/account';
import { useCloudStore } from '@/features/cloud/cloud';

export function ConsentForm({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
    const dispatch = useCloudStore((s) => s.dispatch);
    const setMe = useAccountStore((s) => s.setMe);
    const [agreed, setAgreed] = useState(false);
    const [busy, setBusy] = useState(false);

    // 送信は済んだが、状態の取り直しに失敗したとき（やり直しで二重に送らない）
    const [posted, setPosted] = useState(false);

    const submit = async () => {
        setBusy(true);
        if (!posted) {
            try {
                await postConsent(me, true);
                setPosted(true);
            } catch (e) {
                toast.error(`同意を送れませんでした: ${(e as Error).message}`);
                // 版が変わったかもしれないので、最新の情報に取り直す
                fetchMe()
                    .then(setMe)
                    .catch(() => undefined);
                setBusy(false);
                return;
            }
        }
        // 送れたら、同意済みの状態に取り直して次へ進む。取り直せなければ進まない（再読み込みを促す）
        try {
            setMe(await fetchMe());
            dispatch({ type: 'consented' });
        } catch {
            toast.error('同意は送れましたが、状態を取り直せませんでした。もう一度「同意して進む」を押してください');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <h1 className='text-xl font-semibold'>利用規約への同意</h1>
            <p className='text-sm'>
                使い始める前に、
                <a className='underline' href={me.termsUrl} target='_blank' rel='noreferrer'>
                    利用規約
                </a>
                と
                <a className='underline' href={me.privacyUrl} target='_blank' rel='noreferrer'>
                    プライバシーポリシー
                </a>
                をお読みください
            </p>
            <div className='flex items-center gap-2'>
                <Checkbox id='consent-tos' checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
                <Label htmlFor='consent-tos'>利用規約とプライバシーポリシーに同意する</Label>
            </div>
            <p className='text-xs text-muted-foreground'>
                クラウド版では品質改善のためのデータ収集を行なっています（文字起こしや要約の本文等は収集していません）
            </p>
            <Button disabled={!canSubmitConsent(agreed, busy)} onClick={() => void submit()}>
                同意して進む
            </Button>
            {!agreed && (
                <p className='text-xs text-muted-foreground'>
                    進むには、利用規約とプライバシーポリシーへの同意が必要です
                </p>
            )}
            <p className='text-xs text-muted-foreground'>
                {me.displayName} でログインしています
                <button className='ml-1 underline' onClick={onSignOut}>
                    ログアウト
                </button>
            </p>
        </>
    );
}
