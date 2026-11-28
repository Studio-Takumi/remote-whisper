import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { settingsMessages } from '@/features/settings/i18n';
import { type SummaryLanguage, summaryLanguages } from '@/features/settings/settings';
import { useT } from '@/i18n/messages';

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
    const t = useT(settingsMessages);
    return (
        <Select value={value} onValueChange={(v) => onChange(v as SummaryLanguage)}>
            {/* 幅は w-44 で、英語の長い選択肢（Match display language。#497）のときだけ広げる */}
            <SelectTrigger id={id} className='w-auto min-w-44'>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {summaryLanguages.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                            {'labelKey' in l ? t(l.labelKey) : l.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
