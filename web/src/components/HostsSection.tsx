// アカウントの画面の「ホスト」（#161）。名前の変更と解除。解除するとトンネルも消え、その PC はつながらなくなる
import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { useCloudStore } from '@/cloud';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type Host, removeHost, renameHost, useHostsStore } from '@/hosts';
import { useAppStore } from '@/store';

function HostRow({ host }: { host: Host }) {
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
            toast.error(`名前を変えられません: ${(e as Error).message}`);
        }
    };

    const remove = async () => {
        try {
            setHosts(await removeHost(host.id));
            toast.success(`${host.name} を外しました`);
            // つないでいたホストなら、選び直す
            if (host.id === currentHostId) {
                dispatch({ type: 'changeHost' });
            }
        } catch (e) {
            toast.error(`外せません: ${(e as Error).message}`);
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
                        aria-label='ホストの名前'
                        value={name}
                        maxLength={64}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                    />
                    <Button size='sm' type='submit' disabled={name.trim().length === 0}>
                        保存
                    </Button>
                    <Button size='sm' variant='ghost' type='button' onClick={() => setEditing(false)}>
                        やめる
                    </Button>
                </form>
            ) : (
                <div className='flex items-center justify-between gap-2'>
                    <span className='truncate'>
                        {host.name}
                        <span className='ml-2 text-xs text-muted-foreground'>
                            {host.online === true ? 'オンライン' : host.online === false ? 'オフライン' : ''}
                        </span>
                    </span>
                    <span className='flex shrink-0 gap-1'>
                        <Button
                            size='sm'
                            variant='ghost'
                            aria-label={`${host.name} の名前を変える`}
                            onClick={() => {
                                setName(host.name);
                                setEditing(true);
                            }}
                        >
                            名前
                        </Button>
                        <Button
                            size='sm'
                            variant='ghost'
                            aria-label={`${host.name} を外す`}
                            disabled={locked}
                            title={locked ? '録音中は、つないでいるホストを外せません' : undefined}
                            onClick={() => setConfirming(true)}
                        >
                            外す
                        </Button>
                    </span>
                </div>
            )}
            {confirming && (
                <div className='flex items-center justify-end gap-2'>
                    <span className='text-xs text-destructive'>
                        外すと、この端末はクラウド版からつながらなくなります
                    </span>
                    <Button size='sm' variant='destructive' onClick={() => void remove()}>
                        外す
                    </Button>
                    <Button size='sm' variant='ghost' onClick={() => setConfirming(false)}>
                        やめる
                    </Button>
                </div>
            )}
        </li>
    );
}

export function HostsSection({ open }: { open: boolean }) {
    const { hosts, load } = useHostsStore();
    // 開いたときに取り直す（オンラインかどうかが変わるため）
    useEffect(() => {
        if (open) {
            void load();
        }
    }, [open, load]);

    return (
        <section className='flex flex-col gap-2 border-t pt-3' data-hosts-section>
            <h3 className='font-medium'>ホスト（文字起こしをする PC）</h3>
            {hosts === null ? (
                <p className='text-xs text-muted-foreground'>読み込んでいます…</p>
            ) : hosts.length === 0 ? (
                <p className='text-xs text-muted-foreground'>
                    まだありません。PC のトレイの「クラウド版にログイン」から登録します。
                </p>
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
