import { AudioLinesIcon, FolderPlusIcon } from 'lucide-react';

// 何も選んでいないとき
export function EmptyState({ hasProjects }: { hasProjects: boolean }) {
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            {hasProjects ? <AudioLinesIcon className='size-10' /> : <FolderPlusIcon className='size-10' />}
            <p className='text-lg font-semibold text-foreground'>
                {hasProjects ? 'セッションを開くか、新しく録音しましょう' : 'まずはプロジェクトを作りましょう'}
            </p>
            <p className='max-w-md text-sm'>
                {hasProjects
                    ? 'メニューからセッションを開くか、プロジェクトの ＋ で新しく作れます'
                    : 'メニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください'}
            </p>
        </div>
    );
}
