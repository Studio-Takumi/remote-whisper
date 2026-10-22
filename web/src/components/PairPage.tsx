// ホストの登録の確認（#157。spec/cloud.md 10.6）。トレイの「クラウド版にログイン」が開く /pair?code=… の画面。
// ログインしていなければログインさせてから、PC 名とコードを出して承認・拒否させる。
// コードがトレイの通知と同じかを本人に確かめさせる（ほかの人の PC を自分のアカウントに登録させる乗っ取りの対策）
import { useEffect, useState } from 'react';

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
                    <p className='text-sm'>ログインしてから、登録する PC を確かめます。</p>
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
                    <p className='rounded-md border py-3 text-center font-mono text-2xl tracking-widest'>
                        {view.request.code}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                        PC
                        のトレイの通知に出ているコードと同じか確かめてください。違うときや、心当たりがないときは拒否してください
                    </p>
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
