import { toast } from 'sonner';

// 録音中は中身を操作できないようにする。上に透明な板をかぶせて、触ったら Toast を出す
export function RecordingLock({
    locked,
    className,
    children,
}: {
    locked: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`relative ${className ?? ''}`}>
            <div className={locked ? 'pointer-events-none opacity-50' : ''}>{children}</div>
            {locked && (
                <div
                    className='absolute inset-0 cursor-not-allowed'
                    onClick={() => toast.warning('録音中は設定を変更できません')}
                />
            )}
        </div>
    );
}
