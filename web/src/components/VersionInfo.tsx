import { TriangleAlertIcon } from 'lucide-react';

import { useAppStore } from '@/store';
import { webVersion } from '@/version';

// サーバーと画面のバージョン（コミットハッシュ）を並べて出す。
// 食い違っていたら、ブラウザに古い画面が残っているので、読み込み直すように促す
export function VersionInfo() {
    const serverVersion = useAppStore((s) => s.serverVersion);
    const mismatch = serverVersion !== null && serverVersion !== webVersion;

    return (
        <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
            <p className='font-mono tabular-nums'>
                ホスト {serverVersion ?? '—'} ・ クライアント {webVersion}
            </p>
            {mismatch && (
                <p className='flex items-center gap-1 text-amber-600 dark:text-amber-400' role='status'>
                    <TriangleAlertIcon className='size-3.5 shrink-0' />
                    <span>
                        クライアントがホストと違うバージョンです{' '}
                        <button className='underline underline-offset-2' onClick={() => location.reload()}>
                            読み込み直す
                        </button>
                    </span>
                </p>
            )}
        </div>
    );
}
