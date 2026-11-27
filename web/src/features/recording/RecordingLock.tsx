import { toast } from 'sonner';

import { recordingMessages } from '@/features/recording/i18n';
import { useT } from '@/i18n/messages';

// 録音中は中身を操作できないようにする。上に透明な板をかぶせて、触ったら Toast を出す
export function RecordingLock({
    locked,
    message,
    className,
    children,
}: {
    locked: boolean;
    message?: string;
    className?: string;
    children: React.ReactNode;
}) {
    const t = useT(recordingMessages);
    return (
        <div className={`relative ${className ?? ''}`}>
            <div className={locked ? 'pointer-events-none opacity-50' : ''}>{children}</div>
            {locked && (
                <div
                    className='absolute inset-0 cursor-not-allowed'
                    onClick={() => toast.warning(message ?? t('recordingLock.locked'))}
                />
            )}
        </div>
    );
}
