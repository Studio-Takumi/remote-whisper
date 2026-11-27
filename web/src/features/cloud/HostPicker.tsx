// クラウド版のホストの選択（#161）。0 台なら登録の案内、選べるのが 1 台・前に選んだものならそのままつなぐ、
// ほかは選ぶ画面。オフラインのホストは選べない
import { useEffect, useState } from 'react';

import { MonitorIcon, RefreshCwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCloudStore } from '@/features/cloud/cloud';
import {
    type Host,
    connectedHostId,
    markConnected,
    needsReload,
    page,
    pickHost,
    rememberHost,
    rememberedHost,
    selectable,
    useHostsStore,
} from '@/features/cloud/hosts';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

export function HostPicker() {
    const t = useT(cloudMessages);
    const dispatch = useCloudStore((s) => s.dispatch);
    const { hosts, error, load } = useHostsStore();
    const [choosing, setChoosing] = useState(false);

    const connect = (host: Host) => {
        // 一度つないだら、そのあとは自動でつながない（「切り替える」やホストを外して戻ってきたときは選ばせる。
        // ログアウトすると戻る）
        useHostsStore.setState({ autoPicked: true });
        rememberHost(host.id);
        // 前に別のホストにつないでいたら読み込み直す（#222。spec/cloud.md 10.6）。
        // 画面の状態と WebSocket は前のホストのものなので、作り直すより確実
        if (needsReload(connectedHostId(), host.id)) {
            page.reload();
            return;
        }
        markConnected(host.id);
        dispatch({ type: 'hostSelected', hostId: host.id });
    };

    // 一覧を読み、どうするかを決める（開いたときと、失敗のあとの「もう一度」）
    const start = async () => {
        const list = await load();
        if (!list) {
            return;
        }
        const pick = pickHost(list, rememberedHost());
        if (pick.kind === 'connect' && !useHostsStore.getState().autoPicked) {
            connect(pick.host);
        } else {
            setChoosing(true);
        }
    };

    useEffect(() => {
        void start();
        // 開いたときに 1 回だけ
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) {
        return (
            <div className='flex flex-col gap-2' data-hosts='error'>
                <h1 className='text-xl font-semibold'>{t('hostPicker.errorTitle')}</h1>
                <p role='alert' className='text-sm text-destructive'>
                    {t('hostPicker.loadFailed', { error })}
                </p>
                <Button variant='outline' onClick={() => void start()}>
                    {t('hostPicker.retry')}
                </Button>
            </div>
        );
    }
    if (hosts === null || (!choosing && hosts.length > 0)) {
        return (
            <p role='status' className='text-sm text-muted-foreground'>
                {t('hostPicker.checking')}
            </p>
        );
    }
    if (hosts.length === 0) {
        return (
            <div className='flex flex-col gap-3' data-hosts='none'>
                <h1 className='text-xl font-semibold'>{t('hostPicker.noneTitle')}</h1>
                <p className='text-sm'>{t('hostPicker.noneDescription')}</p>
                <ol className='list-decimal space-y-1 pl-5 text-sm'>
                    <li>{t('hostPicker.noneStart')}</li>
                    <li>{t('hostPicker.noneLogin')}</li>
                    <li>{t('hostPicker.noneApprove')}</li>
                </ol>
                <Button variant='outline' onClick={() => void load()}>
                    <RefreshCwIcon />
                    {t('hostPicker.checkRegistered')}
                </Button>
            </div>
        );
    }
    return (
        <div className='flex flex-col gap-3' data-hosts='choose'>
            <h1 className='text-xl font-semibold'>{t('hostPicker.choose')}</h1>
            <ul className='flex flex-col gap-2'>
                {hosts.map((h) => (
                    <li key={h.id}>
                        <Button
                            variant='outline'
                            className='h-auto w-full justify-between py-3'
                            disabled={!selectable(h)}
                            onClick={() => connect(h)}
                        >
                            <span className='flex items-center gap-2'>
                                <MonitorIcon />
                                {h.name}
                            </span>
                            <span className='text-xs text-muted-foreground'>
                                {h.online === true ? t('common.online') : h.online === false ? t('common.offline') : ''}
                            </span>
                        </Button>
                    </li>
                ))}
            </ul>
            {hosts.every((h) => !selectable(h)) && (
                <p className='text-xs text-muted-foreground'>{t('hostPicker.allOffline')}</p>
            )}
            <Button variant='ghost' size='sm' onClick={() => void load()}>
                <RefreshCwIcon />
                {t('hostPicker.reload')}
            </Button>
        </div>
    );
}
