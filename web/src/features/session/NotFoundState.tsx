import { SearchXIcon } from 'lucide-react';

// URL のセッション・プロジェクトがないとき（#177）
export function NotFoundState() {
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            <SearchXIcon className='size-10' />
            <p className='text-lg font-semibold text-foreground'>見つかりません</p>
            <p className='max-w-md text-sm'>このセッションまたはプロジェクトは、消えたか期限切れです</p>
        </div>
    );
}
