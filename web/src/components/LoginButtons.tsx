// ログインのボタン（Google・Discord・GitHub）。ログインのあとは、今開いている画面に戻る
import { PROVIDER_LABELS, type Provider, loginHref } from '@/account';
import { Button } from '@/components/ui/button';

const PROVIDERS: Provider[] = ['google', 'discord', 'github'];

export function LoginButtons() {
    return (
        <div className='flex flex-col gap-2'>
            {PROVIDERS.map((p) => (
                <Button key={p} variant='outline' asChild>
                    <a href={loginHref(p, { returnTo: location.pathname + location.search })}>
                        {PROVIDER_LABELS[p]} でログイン
                    </a>
                </Button>
            ))}
        </div>
    );
}
