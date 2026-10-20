// クラウド版のアカウントの画面（#155）。ログイン手段の一覧・足す・外す（最後の 1 つは外せない）、ログアウト、退会
import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import {
    PROVIDER_LABELS,
    addableProviders,
    canRemove,
    deleteAccount,
    fetchMe,
    loginHref,
    logout,
    removeIdentity,
    useAccountStore,
} from '@/account';
import { useCloudStore } from '@/cloud';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function AccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { me, setMe } = useAccountStore();
    const dispatch = useCloudStore((s) => s.dispatch);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // 開いたときに取り直す（ほかのタブで足した手段も出すため）
    useEffect(() => {
        if (open) {
            fetchMe()
                .then(setMe)
                .catch(() => undefined);
        }
    }, [open, setMe]);

    const signOut = async () => {
        await logout().catch(() => undefined);
        setMe(null);
        dispatch({ type: 'loggedOut' });
        onOpenChange(false);
    };

    const remove = async (id: string) => {
        try {
            setMe(await removeIdentity(id));
        } catch (e) {
            toast.error(`外せません: ${(e as Error).message}`);
        }
    };

    const leave = async () => {
        try {
            await deleteAccount();
        } catch (e) {
            toast.error(`退会できません: ${(e as Error).message}`);
            return;
        }
        setMe(null);
        dispatch({ type: 'loggedOut' });
        onOpenChange(false);
        toast.success('退会しました');
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                setConfirmDelete(false);
                onOpenChange(o);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>アカウント</DialogTitle>
                    <DialogDescription>{me ? `${me.displayName} でログインしています` : ''}</DialogDescription>
                </DialogHeader>
                {me && (
                    <div className='flex flex-col gap-4 text-sm'>
                        <section className='flex flex-col gap-2'>
                            <h3 className='font-medium'>ログインの手段</h3>
                            <ul className='flex flex-col gap-1.5'>
                                {me.identities.map((i) => (
                                    <li key={i.id} className='flex items-center justify-between gap-2'>
                                        <span>
                                            {PROVIDER_LABELS[i.provider]}
                                            {i.email && <span className='ml-2 text-muted-foreground'>{i.email}</span>}
                                        </span>
                                        <Button
                                            size='sm'
                                            variant='ghost'
                                            disabled={!canRemove(me)}
                                            title={canRemove(me) ? undefined : '最後のログインの手段は外せません'}
                                            onClick={() => void remove(i.id)}
                                        >
                                            外す
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            <div className='flex flex-wrap gap-2'>
                                {addableProviders(me).map((p) => (
                                    <Button key={p} size='sm' variant='outline' asChild>
                                        <a href={loginHref(p, { link: true, returnTo: location.pathname })}>
                                            {PROVIDER_LABELS[p]} を足す
                                        </a>
                                    </Button>
                                ))}
                            </div>
                        </section>
                        <section className='flex flex-wrap items-center justify-between gap-2 border-t pt-3'>
                            <Button size='sm' variant='outline' onClick={() => void signOut()}>
                                ログアウト
                            </Button>
                            {confirmDelete ? (
                                <span className='flex items-center gap-2'>
                                    <span className='text-xs text-destructive'>
                                        アカウントとホストの登録を消します。元に戻せません
                                    </span>
                                    <Button size='sm' variant='destructive' onClick={() => void leave()}>
                                        退会する
                                    </Button>
                                </span>
                            ) : (
                                <Button size='sm' variant='ghost' onClick={() => setConfirmDelete(true)}>
                                    退会…
                                </Button>
                            )}
                        </section>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
