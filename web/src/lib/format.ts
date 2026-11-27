// 数値・日付の表示を、表示言語（#487）に合わせる（#496）。表示言語は呼ぶたびに読む（読み込み時には固めない）
// 日本語のときの出力は、これまでの手作りの書式と同じにする（src/lib/format.test.ts が固定している）
import { type Language, getLanguage } from '@/i18n/language';

const LOCALES: Record<Language, string> = { ja: 'ja-JP', en: 'en-US' };

export function intlLocale(language: Language = getLanguage()): string {
    return LOCALES[language];
}

// 小数の桁を決めた数（例: 1.5）。日本語は桁区切りなし（1234.5）。英語は区切りあり（1,234.5）
export function formatDecimal(value: number, digits: number, language: Language = getLanguage()): string {
    return new Intl.NumberFormat(intlLocale(language), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: language !== 'ja',
    }).format(value);
}

// 月と日だけ（ja: 10/11、en: 10/11）
export function formatMonthDay(ms: number, language: Language = getLanguage()): string {
    return new Date(ms).toLocaleDateString(intlLocale(language), { month: 'numeric', day: 'numeric' });
}
