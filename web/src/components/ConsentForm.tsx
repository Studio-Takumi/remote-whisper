// 初回の同意の画面（#162）。利用規約・プライバシーポリシーへの同意と、データ収集の許可（既定はオフ）
import { useState } from 'react';

import { toast } from 'sonner';

import { type Me, canSubmitConsent, fetchMe, postConsent, useAccountStore } from '@/account';
import { useCloudStore } from '@/cloud';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export function ConsentForm({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
    const dispatch = useCloudStore((s) => s.dispatch);
    const setMe = useAccountStore((s) => s.setMe);
    const [agreed, setAgreed] = useState(false);
    const [dataCollection, setDataCollection] = useState(false);
    const [busy, setBusy] = useState(false);

    // 送信は済んだが、状態の取り直しに失敗したとき（やり直しで二重に送らない）
    const [posted, setPosted] = useState(false);

    const submit = async () => {
        setBusy(true);
        if (!posted) {
            try {
                await postConsent(me, dataCollection);
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
                をお読みください。
            </p>
            <div className='flex items-center gap-2'>
                <Checkbox id='consent-tos' checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
                <Label htmlFor='consent-tos'>利用規約とプライバシーポリシーに同意する</Label>
            </div>
            <section className='flex flex-col gap-2 rounded-md border p-3'>
                <div className='flex items-center justify-between gap-2'>
                    <Label htmlFor='consent-data'>データ収集を許可する（任意）</Label>
                    <Switch
                        id='consent-data'
                        aria-describedby='consent-data-desc'
                        checked={dataCollection}
                        disabled={posted}
                        onCheckedChange={setDataCollection}
                    />
                </div>
                <p id='consent-data-desc' className='text-xs text-muted-foreground'>
                    現在は収集していません。収集を始めるときは、何を何に使うかをここに書きます。あとから設定で変えられます。
                </p>
            </section>
            <Button disabled={!canSubmitConsent(agreed, busy)} onClick={() => void submit()}>
                同意して進む
            </Button>
            {!agreed && (
                <p className='text-xs text-muted-foreground'>
                    進むには、利用規約とプライバシーポリシーへの同意が必要です。
                </p>
            )}
            <p className='text-xs text-muted-foreground'>
                {me.displayName} でログインしています。
                <button className='ml-1 underline' onClick={onSignOut}>
                    ログアウト
                </button>
            </p>
        </>
    );
}
