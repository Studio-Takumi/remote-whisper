import { AudioLinesIcon, FolderPlusIcon } from 'lucide-react';

import { sessionMessages } from '@/features/session/i18n';
import { useT } from '@/i18n/messages';

// 何も選んでいないとき
export function EmptyState({ hasProjects }: { hasProjects: boolean }) {
    const t = useT(sessionMessages);
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            {hasProjects ? <AudioLinesIcon className='size-10' /> : <FolderPlusIcon className='size-10' />}
            <p className='text-lg font-semibold text-foreground'>
                {hasProjects ? t('emptyState.titleWithProjects') : t('emptyState.titleNoProjects')}
            </p>
            <p className='max-w-md text-sm'>
                {hasProjects ? t('emptyState.hintWithProjects') : t('emptyState.hintNoProjects')}
            </p>
        </div>
    );
}
