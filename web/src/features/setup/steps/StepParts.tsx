import { CircleAlertIcon, CircleCheckIcon, ExternalLinkIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

// 手順の枠。見出しの左に、そろっているか（または icon）を出す
export function Step({
    title,
    purpose,
    ok,
    icon,
    children,
}: {
    title: string;
    purpose: string;
    ok?: boolean;
    icon?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className='flex flex-col gap-2 rounded-lg border p-3'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
                {icon ??
                    (ok ? (
                        <CircleCheckIcon
                            className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400'
                            aria-label='そろっています'
                        />
                    ) : (
                        <CircleAlertIcon
                            className='size-4 shrink-0 text-amber-600 dark:text-amber-400'
                            aria-label='足りません'
                        />
                    ))}
                <h3 className='text-sm font-semibold'>{title}</h3>
                <span className='text-xs text-muted-foreground'>{purpose}</span>
            </div>
            <div className='flex flex-col gap-2 text-sm'>{children}</div>
        </section>
    );
}

export function Note({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
    return (
        <p className={warn ? 'text-xs text-amber-700 dark:text-amber-400' : 'text-xs text-muted-foreground'}>
            {children}
        </p>
    );
}

export function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <Button variant='outline' size='sm' asChild>
            <a href={href} target='_blank' rel='noreferrer noopener'>
                {children}
                <ExternalLinkIcon />
            </a>
        </Button>
    );
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
    return (
        <div
            className='h-2 w-full overflow-hidden rounded-full bg-muted'
            role='progressbar'
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
        >
            <div className='h-full bg-primary transition-[width]' style={{ width: `${percent}%` }} />
        </div>
    );
}
