// ログインのボタン（Google・Discord・GitHub）。ログインのあとは、今開いている画面に戻る。
// iOS アプリの中では、リンクの代わりにシステムのログイン画面を出し、終わったら読み込み直す（#441。spec/mobile.md 11.10）
import { toast } from 'sonner';

import { appAuthActive, appLogin, isCanceled } from '@/api/appAuth';
import { Button } from '@/components/ui/button';
import { PROVIDER_LABELS, type Provider, loginHref } from '@/features/cloud/account';

const PROVIDERS: Provider[] = ['google', 'discord', 'github'];

async function loginInApp(provider: Provider) {
    try {
        await appLogin(provider);
    } catch (e) {
        if (!isCanceled(e)) {
            toast.error('ログインできませんでした。もう一度試してください');
        }
        return;
    }
    location.reload();
}

export function LoginButtons() {
    return (
        <div className='flex flex-col gap-2'>
            {PROVIDERS.map((p) =>
                appAuthActive ? (
                    <Button key={p} variant='outline' onClick={() => void loginInApp(p)}>
                        {PROVIDER_LABELS[p]} でログイン
                    </Button>
                ) : (
                    <Button key={p} variant='outline' asChild>
                        <a href={loginHref(p, { returnTo: location.pathname + location.search })}>
                            {PROVIDER_LABELS[p]} でログイン
                        </a>
                    </Button>
                ),
            )}
        </div>
    );
}
