import type { LucideIcon } from 'lucide-react';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function ModelSelect({
    icon: Icon,
    label,
    value,
    options,
    onChange,
}: {
    icon: LucideIcon;
    label: string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
}) {
    return (
        <div className='flex flex-col'>
            <p className='flex items-center gap-1 px-2 text-xs'>
                <Icon className='size-3' />
                {label}
            </p>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger className='w-full max-w-48 border-0'>
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
        </div>
    );
}
