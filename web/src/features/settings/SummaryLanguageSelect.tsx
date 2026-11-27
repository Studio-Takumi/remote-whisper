import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type SummaryLanguage, summaryLanguages } from '@/features/settings/settings';

// 要約の言語（#485）を選ぶ。設定の「要約」ページで使う
export function SummaryLanguageSelect({
    id,
    value,
    onChange,
}: {
    id: string;
    value: SummaryLanguage;
    onChange: (value: SummaryLanguage) => void;
}) {
    return (
        <Select value={value} onValueChange={(v) => onChange(v as SummaryLanguage)}>
            <SelectTrigger id={id} className='w-44'>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {summaryLanguages.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                            {l.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
