// クラウド版のホストの選択（#161）。0 台なら登録の案内、選べるのが 1 台・前に選んだものならそのままつなぐ、
// ほかは選ぶ画面。オフラインのホストは選べない
import { useEffect, useState } from 'react';

import { MonitorIcon, RefreshCwIcon } from 'lucide-react';

import { useCloudStore } from '@/cloud';
import { Button } from '@/components/ui/button';
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
} from '@/hosts';

export function HostPicker() {
    const dispatch = useCloudStore((s) => s.dispatch);
    const { hosts, error, load } = useHostsStore();
    const [choosing, setChoosing] = useState(false);

    const connect = (host: Host) => {
        // 一度つないだら、そのあとは自動でつながない（「切り替える」やホストを外して戻ってきたときは選ばせる。
        // ログアウトすると戻る）
        useHostsStore.setState({ autoPicked: true });
        rememberHost(host.id);
        // このページで前に別のホストにつないでいたら、読み込み直す（#222）。画面の状態（プロジェクト・設定・
        // 録音の残り）と WebSocket は前のホストのものなので、作り直すより読み込み直す方が確実。
        // 読み込み直すと、覚えたホスト（いま選んだもの）に自動でつなぐ
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
                <h1 className='text-xl font-semibold'>ホストの選択</h1>
                <p role='alert' className='text-sm text-destructive'>
                    ホストの一覧を読めませんでした: {error}
                </p>
                <Button variant='outline' onClick={() => void start()}>
                    もう一度
                </Button>
            </div>
        );
    }
    if (hosts === null || (!choosing && hosts.length > 0)) {
        return (
            <p role='status' className='text-sm text-muted-foreground'>
                ホストを確かめています…
            </p>
        );
    }
    if (hosts.length === 0) {
        return (
            <div className='flex flex-col gap-3' data-hosts='none'>
                <h1 className='text-xl font-semibold'>PC を登録してください</h1>
                <p className='text-sm'>文字起こしをする PC（ホスト）が、まだ登録されていません</p>
                <ol className='list-decimal space-y-1 pl-5 text-sm'>
                    <li>PC で Remote Whisper を起動する</li>
                    <li>タスクトレイ（Mac はメニューバー）のアイコンから「クラウド版にログイン」を選ぶ</li>
                    <li>開いた画面で、トレイと同じコードが出ているのを確かめて承認する</li>
                </ol>
                <Button variant='outline' onClick={() => void load()}>
                    <RefreshCwIcon />
                    登録したので確かめる
                </Button>
            </div>
        );
    }
    return (
        <div className='flex flex-col gap-3' data-hosts='choose'>
            <h1 className='text-xl font-semibold'>ホストを選ぶ</h1>
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
                                {h.online === true ? 'オンライン' : h.online === false ? 'オフライン' : ''}
                            </span>
                        </Button>
                    </li>
                ))}
            </ul>
            {hosts.every((h) => !selectable(h)) && (
                <p className='text-xs text-muted-foreground'>
                    どの PC もオフラインです。PC で Remote Whisper が動いているか確かめてください
                </p>
            )}
            <Button variant='ghost' size='sm' onClick={() => void load()}>
                <RefreshCwIcon />
                一覧を読み直す
            </Button>
        </div>
    );
}
