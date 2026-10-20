// クラウド版の入口。ログイン（#155）→ 同意（#162）→ ホストの選択（#161）の順に進む。
// ホストの選択の画面はまだなく、何が入るかだけを出す
import { useEffect } from 'react';

import { PROVIDER_LABELS, type Provider, fetchMe, loginHref, logout, useAccountStore } from '@/account';
import { useCloudStore } from '@/cloud';
import type { CloudStage } from '@/cloud';
import { ConsentForm } from '@/components/ConsentForm';
import { Button } from '@/components/ui/button';

const PLACEHOLDERS: Record<Exclude<CloudStage, 'login' | 'consent'>, { title: string; body: string }> = {
    hosts: { title: 'ホストの選択', body: '使うホスト（文字起こしをするマシン）を選ぶ画面が入ります（#161）。' },
    ready: { title: 'ホストにつながっています', body: '' },
};

const PROVIDERS: Provider[] = ['google', 'discord', 'github'];

export function CloudEntry() {
    const stage = useCloudStore((s) => s.cloud.stage);
    const dispatch = useCloudStore((s) => s.dispatch);
    const { me, checked, setMe } = useAccountStore();

    // 開いたときに、ログインしているかを確かめる
    useEffect(() => {
        if (checked) {
            return;
        }
        fetchMe()
            .then((m) => {
                setMe(m);
                if (m) {
                    dispatch({ type: 'loggedIn', consented: m.tosVersion !== null });
                }
            })
            .catch(() => setMe(null));
    }, [checked, dispatch, setMe]);

    const signOut = async () => {
        await logout().catch(() => undefined);
        setMe(null);
        dispatch({ type: 'loggedOut' });
    };

    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6' data-cloud-stage={stage}>
            <p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版・準備中）</p>
            {stage === 'login' ? (
                <>
                    <h1 className='text-xl font-semibold'>ログイン</h1>
                    {checked ? (
                        <div className='flex flex-col gap-2'>
                            {PROVIDERS.map((p) => (
                                <Button key={p} variant='outline' asChild>
                                    {/* ログインのあとは、今開いている画面に戻る */}
                                    <a href={loginHref(p, { returnTo: location.pathname + location.search })}>
                                        {PROVIDER_LABELS[p]} でログイン
                                    </a>
                                </Button>
                            ))}
                        </div>
                    ) : (
                        <p className='text-sm text-muted-foreground'>確かめています…</p>
                    )}
                </>
            ) : stage === 'consent' ? (
                me ? (
                    <ConsentForm me={me} onSignOut={() => void signOut()} />
                ) : (
                    <p className='text-sm text-muted-foreground'>確かめています…</p>
                )
            ) : (
                <>
                    <h1 className='text-xl font-semibold'>{PLACEHOLDERS[stage].title}</h1>
                    <p className='text-sm'>{PLACEHOLDERS[stage].body}</p>
                    {me && (
                        <p className='text-xs text-muted-foreground'>
                            {me.displayName} でログインしています。
                            <button className='ml-1 underline' onClick={() => void signOut()}>
                                ログアウト
                            </button>
                        </p>
                    )}
                </>
            )}
        </main>
    );
}
