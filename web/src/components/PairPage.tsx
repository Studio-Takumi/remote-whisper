// ホストの登録の確認（#157。spec/cloud.md 10.6）。トレイの「クラウド版にログイン」が開く /pair?code=… の画面。
// ログインしていなければログインさせてから、PC 名とコードを出して承認・拒否させる。
// コードがトレイの通知と同じかを本人に確かめさせる（ほかの人の PC を自分のアカウントに登録させる乗っ取りの対策）。
// 申請した PC と接続元の国が違えば、承認の前に強く知らせる（#251。止めはしない）
import { useEffect, useState } from 'react';

import { TriangleAlertIcon } from 'lucide-react';

import { fetchMe, useAccountStore } from '@/account';
import { LoginButtons } from '@/components/LoginButtons';
import { Button } from '@/components/ui/button';
import { type PairRequest, approvePairing, fetchPairRequest, rejectPairing } from '@/pairing';

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
                  message: `${request.hostName} は、ほかのアカウントで承認されています。心当たりがなければ、PC のトレイから「クラウド版から外す」を選んでください`,
              }
            : { kind: 'done', message: `${request.hostName} は登録済みです` };
    }
    if (request.status === 'rejected') {
        return { kind: 'done', message: 'この登録は拒否されたか、取り消されました' };
    }
    return null;
}

export function PairPage({ code }: { code: string }) {
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
                    message: `${request.hostName} を登録しました。PC のトレイにも通知が出ます`,
                });
            } else {
                await rejectPairing(request.code);
                setView({ kind: 'done', message: '登録を拒否しました' });
            }
        } catch (e) {
            setView({ kind: 'error', message: (e as Error).message });
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6' data-pair-view={view.kind}>
            <p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版）</p>
            <h1 className='text-xl font-semibold'>ホストの登録</h1>
            {!checked ? (
                <p className='text-sm text-muted-foreground'>確かめています…</p>
            ) : !me ? (
                <>
                    <p className='text-sm'>ログインしてから、登録する PC を確かめます</p>
                    <LoginButtons />
                </>
            ) : view.kind === 'loading' ? (
                <p className='text-sm text-muted-foreground'>読み込んでいます…</p>
            ) : view.kind === 'error' ? (
                <p className='text-sm text-destructive'>{view.message}</p>
            ) : view.kind === 'done' ? (
                <>
                    <p className='text-sm'>{view.message}</p>
                    <Button variant='outline' asChild>
                        <a href='/'>Remote Whisper を開く</a>
                    </Button>
                </>
            ) : (
                <>
                    <p className='text-sm'>
                        <span className='font-medium'>{view.request.hostName}</span> を {me.displayName}{' '}
                        のアカウントに登録しますか？
                    </p>
                    <PairChecks request={view.request} />
                    <div className='flex gap-2'>
                        <Button disabled={busy} onClick={() => void answer(true, view.request)}>
                            承認する
                        </Button>
                        <Button variant='outline' disabled={busy} onClick={() => void answer(false, view.request)}>
                            拒否する
                        </Button>
                    </div>
                </>
            )}
        </main>
    );
}

// 承認の前に見てもらうもの: 接続元の国が違うときの警告（#251）・コード・確かめること
export function PairChecks({ request }: { request: PairRequest }) {
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
                            <span className='inline-block'>この PC が手元にないなら</span>
                            <span className='inline-block'>承認しないでください</span>
                        </p>
                        <p className='text-xs'>申請した PC と、この端末の接続元の国が違います</p>
                    </div>
                </div>
            )}
            <p className='rounded-md border py-3 text-center font-mono text-2xl tracking-widest'>{request.code}</p>
            <ul className='list-disc space-y-1 pl-4 text-xs text-muted-foreground'>
                <li>
                    PC
                    のトレイの通知に出ているコードと同じか確かめてください。違うときや、心当たりがないときは拒否してください
                </li>
                <li>人から送られてきたコードは承認しないでください</li>
            </ul>
        </>
    );
}
