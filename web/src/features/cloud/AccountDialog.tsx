// クラウド版のアカウントの画面（#155）。ログイン手段の一覧・足す・外す（最後の 1 つは外せない）、ログアウト、退会
import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { appAuthActive } from '@/api/appAuth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DevicesSection } from '@/features/cloud/DevicesSection';
import { HostsSection } from '@/features/cloud/HostsSection';
import {
    PROVIDER_LABELS,
    addableProviders,
    canRemove,
    deleteAccount,
    fetchMe,
    loginHref,
    logout,
    logoutEverywhere,
    removeIdentity,
    useAccountStore,
} from '@/features/cloud/account';
import { useCloudStore } from '@/features/cloud/cloud';
import { cloudMessages } from '@/features/cloud/i18n';
import { stopPushOnSignOut } from '@/features/settings/push';
import { useT } from '@/i18n/messages';

export function AccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const t = useT(cloudMessages);
    const { me, setMe } = useAccountStore();
    const dispatch = useCloudStore((s) => s.dispatch);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmAll, setConfirmAll] = useState(false);

    // 開いたときに取り直す（ほかのタブで足した手段も出すため）
    useEffect(() => {
        if (open) {
            fetchMe()
                .then(setMe)
                .catch(() => undefined);
        }
    }, [open, setMe]);

    const signOut = async () => {
        // 通知の購読をやめる（同じブラウザでほかのアカウントがログインしても届かないように。#245）。
        // ホストから消す DELETE はログイン中でないと通らないので、ログアウトの前に
        await stopPushOnSignOut();
        await logout().catch(() => undefined);
        setMe(null);
        dispatch({ type: 'loggedOut' });
        onOpenChange(false);
    };

    // すべての端末からログアウト（#250）。成功したら、今の端末もログアウトしてログインの画面に戻る
    const signOutEverywhere = async () => {
        await stopPushOnSignOut();
        try {
            await logoutEverywhere();
        } catch (e) {
            toast.error(t('accountDialog.logoutEverywhereFailed', { message: (e as Error).message }));
            return;
        }
        setConfirmAll(false);
        setMe(null);
        dispatch({ type: 'loggedOut' });
        onOpenChange(false);
    };

    const remove = async (id: string) => {
        try {
            setMe(await removeIdentity(id));
        } catch (e) {
            toast.error(t('common.removeFailed', { message: (e as Error).message }));
        }
    };

    const leave = async () => {
        await stopPushOnSignOut();
        try {
            await deleteAccount();
        } catch (e) {
            toast.error(t('accountDialog.deleteAccountFailed', { message: (e as Error).message }));
            return;
        }
        setMe(null);
        dispatch({ type: 'loggedOut' });
        onOpenChange(false);
        toast.success(t('accountDialog.deleted'));
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                setConfirmDelete(false);
                setConfirmAll(false);
                onOpenChange(o);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('accountDialog.title')}</DialogTitle>
                    <DialogDescription>{me ? t('common.loggedInAs', { name: me.displayName }) : ''}</DialogDescription>
                </DialogHeader>
                {me && (
                    <div className='flex flex-col gap-4 text-sm'>
                        <section className='flex flex-col gap-2'>
                            <h3 className='font-medium'>{t('accountDialog.providers')}</h3>
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
                                            title={
                                                canRemove(me) ? undefined : t('accountDialog.lastProviderCannotRemove')
                                            }
                                            onClick={() => void remove(i.id)}
                                        >
                                            {t('common.remove')}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            {appAuthActive ? (
                                // 手段を足すのは Cookie のログインセッションが要るので、アプリではできない（#441）
                                addableProviders(me).length > 0 && (
                                    <p className='text-xs text-muted-foreground'>{t('accountDialog.cannotAddInApp')}</p>
                                )
                            ) : (
                                <div className='flex flex-wrap gap-2'>
                                    {addableProviders(me).map((p) => (
                                        <Button key={p} size='sm' variant='outline' asChild>
                                            <a href={loginHref(p, { link: true, returnTo: location.pathname })}>
                                                {t('accountDialog.addProvider', { provider: PROVIDER_LABELS[p] })}
                                            </a>
                                        </Button>
                                    ))}
                                </div>
                            )}
                        </section>
                        <HostsSection open={open} />
                        <DevicesSection open={open} />
                        <section className='flex flex-col gap-2 border-t pt-3'>
                            <div className='flex flex-wrap items-center gap-2'>
                                <Button size='sm' variant='outline' onClick={() => void signOut()}>
                                    {t('common.logout')}
                                </Button>
                                {!confirmAll && (
                                    <Button
                                        size='sm'
                                        variant='outline'
                                        onClick={() => {
                                            setConfirmDelete(false);
                                            setConfirmAll(true);
                                        }}
                                    >
                                        {t('accountDialog.logoutEverywhere')}
                                    </Button>
                                )}
                            </div>
                            {confirmAll && (
                                <div className='flex flex-wrap items-center gap-2'>
                                    <span className='text-xs text-destructive'>
                                        {t('accountDialog.logoutEverywhereConfirm')}
                                    </span>
                                    <Button size='sm' variant='destructive' onClick={() => void signOutEverywhere()}>
                                        {t('accountDialog.logoutEverywhereDo')}
                                    </Button>
                                    <Button size='sm' variant='ghost' onClick={() => setConfirmAll(false)}>
                                        {t('common.cancel')}
                                    </Button>
                                </div>
                            )}
                        </section>
                        <section className='flex flex-wrap items-center justify-end gap-2 border-t pt-3'>
                            {confirmDelete ? (
                                <span className='flex items-center gap-2'>
                                    <span className='text-xs text-destructive'>
                                        {t('accountDialog.deleteAccountConfirm')}
                                    </span>
                                    <Button size='sm' variant='destructive' onClick={() => void leave()}>
                                        {t('accountDialog.deleteAccount')}
                                    </Button>
                                </span>
                            ) : (
                                <Button
                                    size='sm'
                                    variant='ghost'
                                    onClick={() => {
                                        setConfirmAll(false);
                                        setConfirmDelete(true);
                                    }}
                                >
                                    {t('accountDialog.deleteAccountStart')}
                                </Button>
                            )}
                        </section>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
