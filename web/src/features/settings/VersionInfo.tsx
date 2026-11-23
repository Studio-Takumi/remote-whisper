import { CircleArrowUpIcon, TriangleAlertIcon } from 'lucide-react';

import { useAppStore } from '@/app/store';
import { minorVersion, webVersion } from '@/app/version';

// サーバーと画面のバージョン（v1.0.0+34a7607 の形）を並べて出す。
// 食い違っていたら、ブラウザに古い画面が残っているので、読み込み直すように促す
export function VersionInfo() {
    const serverVersion = useAppStore((s) => s.serverVersion);
    const hostUpdate = useAppStore((s) => s.hostUpdate);
    const mismatch = serverVersion !== null && serverVersion !== webVersion;

    return (
        <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
            <p className='font-mono tabular-nums'>
                ホスト {serverVersion ?? '—'} ・ クライアント {webVersion}
            </p>
            {/* ホストの新しい版（#472）。x.y が上がったときだけ */}
            {hostUpdate && (
                <p className='flex items-center gap-1 text-sky-700 dark:text-sky-400' role='status'>
                    <CircleArrowUpIcon className='size-3.5 shrink-0' />
                    <span>
                        {minorVersion(hostUpdate.version)} が出ています{' '}
                        <a
                            className='underline underline-offset-2'
                            href={hostUpdate.url}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            リリースノート
                        </a>
                    </span>
                </p>
            )}
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
