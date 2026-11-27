// アカウントの画面の「アプリの端末」（#441）。iOS アプリでログインした端末の一覧と、外す（その端末のトークンはすぐ使えなくなる）。
// アプリでログインした端末がなければ何も出さない（ブラウザだけで使っている人の画面は変えない）
import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { type Device, fetchDevices, removeDevice } from '@/features/cloud/account';
import { cloudMessages } from '@/features/cloud/i18n';
import { useT } from '@/i18n/messages';

function lastSeenLabel(ms: number) {
    return new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

export function DevicesSection({ open }: { open: boolean }) {
    const t = useT(cloudMessages);
    const [devices, setDevices] = useState<Device[]>([]);

    useEffect(() => {
        if (open) {
            fetchDevices()
                .then(setDevices)
                .catch(() => setDevices([]));
        }
    }, [open]);

    if (devices.length === 0) {
        return null;
    }

    const remove = async (d: Device) => {
        try {
            setDevices(await removeDevice(d.id));
            toast.success(t('common.removed', { name: d.name }));
        } catch (e) {
            toast.error(t('common.removeFailed', { message: (e as Error).message }));
        }
    };

    return (
        <section className='flex flex-col gap-2 border-t pt-3'>
            <h3 className='font-medium'>{t('devicesSection.title')}</h3>
            <ul className='flex flex-col gap-1.5'>
                {devices.map((d) => (
                    <li key={d.id} className='flex items-center justify-between gap-2' data-device-row={d.id}>
                        <span className='truncate'>
                            {d.name}
                            <span className='ml-2 text-xs text-muted-foreground'>
                                {d.current
                                    ? t('devicesSection.thisDevice')
                                    : t('devicesSection.lastUsed', { date: lastSeenLabel(d.lastSeenAt) })}
                            </span>
                        </span>
                        {!d.current && (
                            <Button size='sm' variant='ghost' onClick={() => void remove(d)}>
                                {t('common.remove')}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
            <p className='text-xs text-muted-foreground'>{t('devicesSection.notice')}</p>
        </section>
    );
}
