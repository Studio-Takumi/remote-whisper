// アカウントの画面の「ホスト」（#161）。名前の変更と解除。解除するとトンネルも消え、その PC はつながらなくなる
import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCloudStore } from '@/features/cloud/cloud';
import { type Host, removeHost, renameHost, useHostsStore } from '@/features/cloud/hosts';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

function HostRow({ host }: { host: Host }) {
    const t = useT(cloudMessages);
    const setHosts = useHostsStore((s) => s.set);
    const currentHostId = useCloudStore((s) => s.cloud.hostId);
    const dispatch = useCloudStore((s) => s.dispatch);
    // 録音中は、つないでいるホストを外せない（録音が途中で切れるため）
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const locked = recording && host.id === currentHostId;
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(host.name);
    const [confirming, setConfirming] = useState(false);

    const save = async () => {
        try {
            setHosts(await renameHost(host.id, name));
            setEditing(false);
        } catch (e) {
            toast.error(t('hostsSection.renameFailed', { message: (e as Error).message }));
        }
    };

    const remove = async () => {
        try {
            setHosts(await removeHost(host.id));
            toast.success(t('common.removed', { name: host.name }));
            // つないでいたホストなら、選び直す
            if (host.id === currentHostId) {
                dispatch({ type: 'changeHost' });
            }
        } catch (e) {
            toast.error(t('common.removeFailed', { message: (e as Error).message }));
        }
    };

    return (
        <li className='flex flex-col gap-1.5' data-host-row={host.id}>
            {editing ? (
                <form
                    className='flex items-center gap-2'
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    <Input
                        aria-label={t('hostsSection.hostName')}
                        value={name}
                        maxLength={64}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                    />
                    <Button size='sm' type='submit' disabled={name.trim().length === 0}>
                        {t('hostsSection.save')}
                    </Button>
                    <Button size='sm' variant='ghost' type='button' onClick={() => setEditing(false)}>
                        {t('common.cancel')}
                    </Button>
                </form>
            ) : (
                <div className='flex items-center justify-between gap-2'>
                    <span className='truncate'>
                        {host.name}
                        <span className='ml-2 text-xs text-muted-foreground'>
                            {host.online === true
                                ? t('common.online')
                                : host.online === false
                                  ? t('common.offline')
                                  : ''}
                        </span>
                    </span>
                    <span className='flex shrink-0 gap-1'>
                        <Button
                            size='sm'
                            variant='ghost'
                            aria-label={t('hostsSection.renameLabel', { name: host.name })}
                            onClick={() => {
                                setName(host.name);
                                setEditing(true);
                            }}
                        >
                            {t('hostsSection.rename')}
                        </Button>
                        <Button
                            size='sm'
                            variant='ghost'
                            aria-label={t('hostsSection.removeLabel', { name: host.name })}
                            disabled={locked}
                            title={locked ? t('hostsSection.removeLockedRecording') : undefined}
                            onClick={() => setConfirming(true)}
                        >
                            {t('common.remove')}
                        </Button>
                    </span>
                </div>
            )}
            {confirming && (
                <div className='flex items-center justify-end gap-2'>
                    <span className='text-xs text-destructive'>{t('hostsSection.removeConfirm')}</span>
                    <Button size='sm' variant='destructive' onClick={() => void remove()}>
                        {t('common.remove')}
                    </Button>
                    <Button size='sm' variant='ghost' onClick={() => setConfirming(false)}>
                        {t('common.cancel')}
                    </Button>
                </div>
            )}
        </li>
    );
}

export function HostsSection({ open }: { open: boolean }) {
    const t = useT(cloudMessages);
    const { hosts, load } = useHostsStore();
    // 開いたときに取り直す（オンラインかどうかが変わるため）
    useEffect(() => {
        if (open) {
            void load();
        }
    }, [open, load]);

    return (
        <section className='flex flex-col gap-2 border-t pt-3' data-hosts-section>
            <h3 className='font-medium'>{t('hostsSection.title')}</h3>
            {hosts === null ? (
                <p className='text-xs text-muted-foreground'>{t('common.loading')}</p>
            ) : hosts.length === 0 ? (
                <p className='text-xs text-muted-foreground'>{t('hostsSection.empty')}</p>
            ) : (
                <ul className='flex flex-col gap-2'>
                    {hosts.map((h) => (
                        <HostRow key={h.id} host={h} />
                    ))}
                </ul>
            )}
        </section>
    );
}
