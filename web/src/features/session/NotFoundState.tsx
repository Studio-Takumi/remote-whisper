import { SearchXIcon } from 'lucide-react';

import { sessionMessages } from '@/features/session/i18n';
import { useT } from '@/i18n/messages';

// URL のセッション・プロジェクトがないとき（#177）
export function NotFoundState() {
    const t = useT(sessionMessages);
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            <SearchXIcon className='size-10' />
            <p className='text-lg font-semibold text-foreground'>{t('notFoundState.title')}</p>
            <p className='max-w-md text-sm'>{t('notFoundState.description')}</p>
        </div>
    );
}
