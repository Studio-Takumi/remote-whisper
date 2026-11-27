// 初回の同意の画面（#162）。利用規約・プライバシーポリシーへの同意。
// データ収集は同意と一緒に許可として記録し、ここでは知らせるだけ（変える画面は置かない）
import { useState } from 'react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { type Me, canSubmitConsent, fetchMe, postConsent, useAccountStore } from '@/features/cloud/account';
import { useCloudStore } from '@/features/cloud/cloud';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

export function ConsentForm({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
    const t = useT(cloudMessages);
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
                toast.error(t('consentForm.consentFailed', { message: (e as Error).message }));
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
            toast.error(t('consentForm.refetchFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <h1 className='text-xl font-semibold'>{t('consentForm.title')}</h1>
            <p className='text-sm'>
                {t('consentForm.introBefore')}
                <a className='underline' href={me.termsUrl} target='_blank' rel='noreferrer'>
                    {t('consentForm.terms')}
                </a>
                {t('consentForm.introAnd')}
                <a className='underline' href={me.privacyUrl} target='_blank' rel='noreferrer'>
                    {t('consentForm.privacy')}
                </a>
                {t('consentForm.introAfter')}
            </p>
            <div className='flex items-center gap-2'>
                <Checkbox id='consent-tos' checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
                <Label htmlFor='consent-tos'>{t('consentForm.agree')}</Label>
            </div>
            <p className='text-xs text-muted-foreground'>{t('consentForm.dataCollection')}</p>
            <Button disabled={!canSubmitConsent(agreed, busy)} onClick={() => void submit()}>
                {t('consentForm.submit')}
            </Button>
            {!agreed && <p className='text-xs text-muted-foreground'>{t('consentForm.agreeRequired')}</p>}
            <p className='text-xs text-muted-foreground'>
                {t('common.loggedInAs', { name: me.displayName })}
                <button className='ml-1 underline' onClick={onSignOut}>
                    {t('common.logout')}
                </button>
            </p>
        </>
    );
}
