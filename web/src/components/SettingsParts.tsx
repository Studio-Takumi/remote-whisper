import { LockIcon } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function Section({
    title,
    description,
    children,
}: {
    title?: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <section className='flex flex-col gap-1 not-first:mt-6'>
            {title && <h3 className='text-sm font-semibold'>{title}</h3>}
            {description && <p className='text-xs text-muted-foreground'>{description}</p>}
            <div className='flex flex-col divide-y'>{children}</div>
        </section>
    );
}

// 左に項目名と説明、右に入力欄。locked（録音中に変えられない理由）があれば、入力欄を押せなくして理由を出す
export function Row({
    id,
    label,
    description,
    locked,
    children,
}: {
    id: string;
    label: string;
    description?: React.ReactNode;
    locked?: string;
    children: React.ReactNode;
}) {
    return (
        // スマホの幅では、項目名と説明の下に入力欄を置く
        <div className='flex flex-col items-start gap-2 py-3 md:flex-row md:items-center md:justify-between md:gap-4'>
            <div className='flex flex-col gap-1'>
                <Label htmlFor={id}>{label}</Label>
                {description && <div className='text-xs text-muted-foreground'>{description}</div>}
                {locked && (
                    <p className='flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400'>
                        <LockIcon className='size-3 shrink-0' />
                        {locked}
                    </p>
                )}
            </div>
            {/* fieldset を disabled にすると、中の入力欄・ボタン（Select・Switch）をまとめて押せなくできる */}
            <fieldset disabled={locked !== undefined} className='shrink-0 disabled:opacity-50'>
                {children}
            </fieldset>
        </div>
    );
}

export function OptionSelect({
    id,
    value,
    options,
    onChange,
}: {
    id: string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger id={id} className='w-44'>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {options.map((o) => (
                        <SelectItem key={o} value={o}>
                            {o}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
