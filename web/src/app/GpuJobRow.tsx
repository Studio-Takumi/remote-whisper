import type { JobSession } from '@/app/gpuJobs';

// 実行中・待ちの1行。セッションがあれば行全体がそのセッションのページへのリンクになる（#269）
// progress があれば（実行中の浄書・最終要約。#340）、種類の横に段階と件数を、下に細いバーを出す
export function GpuJobRow({
    label,
    kind,
    session,
    time,
    progress = null,
    onOpenSession,
}: {
    label: string;
    kind: string;
    session: JobSession | null;
    time: string;
    progress?: { text: string; ratio: number | null } | null;
    onOpenSession: (projectId: string, sessionId: string) => void;
}) {
    const body = (
        <>
            <div className='flex items-baseline justify-between gap-2'>
                <div className='min-w-0'>
                    <p className='truncate'>{label}</p>
                    {session && (
                        <p className='truncate text-xs text-muted-foreground'>
                            {session.title}
                            {session.href === null && '（見つかりません）'}
                        </p>
                    )}
                </div>
                <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{time}</span>
            </div>
            {progress && (
                <div className='mt-1 flex items-center gap-2'>
                    {/* 件数も % もない段階は、文だけを左に出す */}
                    {progress.ratio !== null && (
                        <div
                            role='progressbar'
                            aria-label={`${kind}の進み具合`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(progress.ratio * 100)}
                            aria-valuetext={progress.text}
                            className='h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted'
                        >
                            <div
                                className='h-full rounded-full bg-primary transition-[width] duration-500'
                                style={{ width: `${progress.ratio * 100}%` }}
                            />
                        </div>
                    )}
                    <span className='shrink-0 text-xs text-foreground/80 tabular-nums'>{progress.text}</span>
                </div>
            )}
        </>
    );
    // 読み上げでは、経過時間の前に段階と件数を入れる
    const detail = progress ? `${progress.text}、${time}` : time;
    const base = 'flex flex-col';
    if (!session || session.href === null || !session.projectId || !session.sessionId) {
        return <div className={base}>{body}</div>;
    }
    const { href, projectId, sessionId } = session;
    return (
        <a
            href={href}
            aria-label={`${kind}のセッション「${session.title}」を開く（${detail}）`}
            className={`${base} -mx-1.5 rounded-md px-1.5 py-0.5 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50`}
            onClick={(e) => {
                // Ctrl・⌘・Shift 押しや中ボタンはブラウザに任せる（別のタブで開く）
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                    return;
                }
                e.preventDefault();
                onOpenSession(projectId, sessionId);
            }}
        >
            {body}
        </a>
    );
}
