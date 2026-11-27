// ホストの登録の確認（#157・#251。spec/cloud.md 10.6）。トレイの「クラウド版にログイン」が開く /pair?code=… の画面。
// コードの照合と、接続元の国が違うときの警告もここで出す
import { useEffect, useState } from 'react';

import { TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { LoginButtons } from '@/features/cloud/LoginButtons';
import { fetchMe, useAccountStore } from '@/features/cloud/account';
import { cloudMessages } from '@/features/cloud/i18n';
import { type PairRequest, approvePairing, fetchPairRequest, rejectPairing } from '@/features/cloud/pairing';
import { useT } from '@/i18n/messages';

type View =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ask'; request: PairRequest }
    | { kind: 'done'; message: string }
    | { kind: 'error'; message: string };

export function settled(request: PairRequest): View | null {
    if (request.status === 'approved') {
        // ほかの人が先に承認していたら、コードが漏れたかもしれない
        return request.answeredByMe === false
            ? {
                  kind: 'error',
                  message: cloudMessages.t('pairPage.errorApprovedByOther', { host: request.hostName }),
              }
            : { kind: 'done', message: cloudMessages.t('pairPage.doneAlreadyRegistered', { host: request.hostName }) };
    }
    if (request.status === 'rejected') {
        return { kind: 'done', message: cloudMessages.t('pairPage.errorRejectedOrCanceled') };
    }
    return null;
}

export function PairPage({ code }: { code: string }) {
    const t = useT(cloudMessages);
    const { me, checked, setMe } = useAccountStore();
    const [view, setView] = useState<View>({ kind: 'loading' });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!checked) {
            fetchMe()
                .then(setMe)
                .catch(() => setMe(null));
        }
    }, [checked, setMe]);

    useEffect(() => {
        if (!me) {
            return;
        }
        fetchPairRequest(code)
            .then((request) => setView(settled(request) ?? { kind: 'ask', request }))
            .catch((e: Error) => setView({ kind: 'error', message: e.message }));
    }, [me, code]);

    const answer = async (approve: boolean, request: PairRequest) => {
        setBusy(true);
        try {
            if (approve) {
                await approvePairing(request.code);
                setView({
                    kind: 'done',
                    message: cloudMessages.t('pairPage.doneRegistered', { host: request.hostName }),
                });
            } else {
                await rejectPairing(request.code);
                setView({ kind: 'done', message: cloudMessages.t('pairPage.doneRejected') });
            }
        } catch (e) {
            setView({ kind: 'error', message: (e as Error).message });
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6' data-pair-view={view.kind}>
            <p className='text-xs text-muted-foreground'>{t('common.appNameCloudEdition')}</p>
            <h1 className='text-xl font-semibold'>{t('pairPage.registerHost')}</h1>
            {!checked ? (
                <p className='text-sm text-muted-foreground'>{t('common.checking')}</p>
            ) : !me ? (
                <>
                    <p className='text-sm'>{t('pairPage.loginFirst')}</p>
                    <LoginButtons />
                </>
            ) : view.kind === 'loading' ? (
                <p className='text-sm text-muted-foreground'>{t('common.loading')}</p>
            ) : view.kind === 'error' ? (
                <p className='text-sm text-destructive'>{view.message}</p>
            ) : view.kind === 'done' ? (
                <>
                    <p className='text-sm'>{view.message}</p>
                    <Button variant='outline' asChild>
                        <a href='/'>{t('pairPage.openApp')}</a>
                    </Button>
                </>
            ) : (
                <>
                    <p className='text-sm'>
                        <span className='font-medium'>{view.request.hostName}</span>{' '}
                        {t('pairPage.askAfterHost', { name: me.displayName })}
                    </p>
                    <PairChecks request={view.request} />
                    <div className='flex gap-2'>
                        <Button disabled={busy} onClick={() => void answer(true, view.request)}>
                            {t('pairPage.approve')}
                        </Button>
                        <Button variant='outline' disabled={busy} onClick={() => void answer(false, view.request)}>
                            {t('pairPage.reject')}
                        </Button>
                    </div>
                </>
            )}
        </main>
    );
}

// 承認の前に見てもらうもの: 接続元の国が違うときの警告（#251）・コード・確かめること
export function PairChecks({ request }: { request: PairRequest }) {
    const t = useT(cloudMessages);
    return (
        <>
            {request.countryMismatch && (
                <div
                    role='alert'
                    data-pair-warning='country'
                    className='flex gap-2 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300'
                >
                    <TriangleAlertIcon className='mt-0.5 size-4 shrink-0' />
                    <div className='flex min-w-0 flex-col gap-1'>
                        <p className='font-semibold'>
                            {/* 狭い幅でも、文節の途中で折り返さない */}
                            <span className='inline-block'>{t('pairPage.noPcWarningFirst')}</span>
                            <span className='inline-block'>{t('pairPage.noPcWarningSecond')}</span>
                        </p>
                        <p className='text-xs'>{t('pairPage.countryMismatch')}</p>
                    </div>
                </div>
            )}
            <p className='rounded-md border py-3 text-center font-mono text-2xl tracking-widest'>{request.code}</p>
            <ul className='list-disc space-y-1 pl-4 text-xs text-muted-foreground'>
                <li>{t('pairPage.checkCode')}</li>
                <li>{t('pairPage.doNotApproveCode')}</li>
            </ul>
        </>
    );
}
