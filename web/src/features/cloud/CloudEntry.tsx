// クラウド版の入口。ログイン（#155）→ 同意（#162）→ ホストの選択（#161）の順に進む。
import { useEffect } from 'react';

import { ConsentForm } from '@/features/cloud/ConsentForm';
import { HostPicker } from '@/features/cloud/HostPicker';
import { LoginButtons } from '@/features/cloud/LoginButtons';
import { fetchMe, logout, useAccountStore } from '@/features/cloud/account';
import { useCloudStore } from '@/features/cloud/cloud';
import { stopPushOnSignOut } from '@/features/settings/push';

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
        // 通知の購読をやめてからログアウトする（#245。AccountDialog と同じ）
        await stopPushOnSignOut();
        await logout().catch(() => undefined);
        setMe(null);
        dispatch({ type: 'loggedOut' });
    };

    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6' data-cloud-stage={stage}>
            <p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版）</p>
            {stage === 'login' ? (
                <>
                    <h1 className='text-xl font-semibold'>ログイン</h1>
                    {checked ? <LoginButtons /> : <p className='text-sm text-muted-foreground'>確かめています…</p>}
                </>
            ) : stage === 'consent' ? (
                me ? (
                    <ConsentForm me={me} onSignOut={() => void signOut()} />
                ) : (
                    <p className='text-sm text-muted-foreground'>確かめています…</p>
                )
            ) : (
                // ホストを選んだら（ready）App がアプリの画面に切り替えるので、ここに来るのは hosts だけ
                <HostPicker />
            )}
        </main>
    );
}
