// ログインのボタン（Google・Discord・GitHub）。ログインのあとは、今開いている画面に戻る。
// iOS アプリの中では、リンクの代わりにシステムのログイン画面を出し、終わったら読み込み直す（#441。spec/mobile.md 11.10）
import { useState } from 'react';

import { toast } from 'sonner';

import { appAuthActive, appLogin, isCanceled } from '@/api/appAuth';
import { Button } from '@/components/ui/button';
import { PROVIDER_LABELS, type Provider, loginHref } from '@/features/cloud/account';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

const PROVIDERS: Provider[] = ['google', 'discord', 'github'];

// true ならログインできた（読み込み直す）
async function loginInApp(provider: Provider) {
    try {
        await appLogin(provider);
        return true;
    } catch (e) {
        if (!isCanceled(e)) {
            toast.error(cloudMessages.t('loginButtons.loginFailed'));
        }
        return false;
    }
}

export function LoginButtons() {
    const t = useT(cloudMessages);
    // ログインの画面を出している間は、ほかのボタンも押せないようにする（連打で 2 つ目が失敗するため）
    const [busy, setBusy] = useState(false);
    const start = async (p: Provider) => {
        setBusy(true);
        if (await loginInApp(p)) {
            location.reload();
            return;
        }
        setBusy(false);
    };
    return (
        <div className='flex flex-col gap-2'>
            {PROVIDERS.map((p) =>
                appAuthActive ? (
                    <Button key={p} variant='outline' disabled={busy} onClick={() => void start(p)}>
                        {t('loginButtons.logInWith', { provider: PROVIDER_LABELS[p] })}
                    </Button>
                ) : (
                    <Button key={p} variant='outline' asChild>
                        <a href={loginHref(p, { returnTo: location.pathname + location.search })}>
                            {t('loginButtons.logInWith', { provider: PROVIDER_LABELS[p] })}
                        </a>
                    </Button>
                ),
            )}
        </div>
    );
}
