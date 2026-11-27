import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Row } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import { type Language, isLanguage, setLanguage, useLanguage } from '@/i18n/language';
import { useT } from '@/i18n/messages';

// 言語の名前は、どの表示言語でもその言語で書く（読めない言語の中からでも自分の言語を探せるように）
const options: { value: Language; label: string }[] = [
    { value: 'ja', label: '日本語' },
    { value: 'en', label: 'English' },
];

// 設定モーダル（表示・その他）の「この端末」の表示言語（#487）。テーマと同じく端末ごと（localStorage）で、選んだ時点で効く
export function LanguageRow() {
    const t = useT(settingsMessages);
    const language = useLanguage();
    return (
        <Row id='language' label={t('languageRow.label')}>
            <Select value={language} onValueChange={(v) => isLanguage(v) && setLanguage(v)}>
                <SelectTrigger id='language' className='w-44'>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        {options.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                                {o.label}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Row>
    );
}
