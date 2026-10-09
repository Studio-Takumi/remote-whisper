import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function ModelSelect({ label, value, options }: { label: string; value: string; options: string[] }) {
    return (
        <div className='flex flex-col'>
            <p className='px-2 text-xs'>{label}</p>
            <Select defaultValue={value}>
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
