// 数値・日付の表示を、表示言語（#487）に合わせる（#496）。表示言語は呼ぶたびに読む（読み込み時には固めない）
// 日本語のときの出力は、これまでの手作りの書式と同じにする（src/lib/format.test.ts が固定している）
import { type Language, getLanguage } from '@/i18n/language';

const LOCALES: Record<Language, string> = { ja: 'ja-JP', en: 'en-US' };

export function intlLocale(language: Language = getLanguage()): string {
    return LOCALES[language];
}

// Intl の生成は重いので、言語と設定ごとに 1 つ作って使い回す
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

export function dateTimeFormat(language: Language, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${language}|${JSON.stringify(options)}`;
    let format = dateFormats.get(key);
    if (!format) {
        format = new Intl.DateTimeFormat(intlLocale(language), options);
        dateFormats.set(key, format);
    }
    return format;
}

// 小数の桁を決めた数（例: 1.5）。日本語は toFixed そのまま（桁区切りなし。1234.5）。
// 英語は toFixed で丸めてから Intl に渡し（丸めを日本語とそろえる）、桁区切りあり（1,234.5）
export function formatDecimal(value: number, digits: number, language: Language = getLanguage()): string {
    const fixed = value.toFixed(digits);
    if (language === 'ja') {
        return fixed;
    }
    const key = `${language}|${digits}`;
    let format = numberFormats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(intlLocale(language), {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
        numberFormats.set(key, format);
    }
    return format.format(Number(fixed));
}

// 月と日だけ（ja: 10/11、en: Oct 11）
export function formatMonthDay(ms: number, language: Language = getLanguage()): string {
    return dateTimeFormat(language, { month: language === 'ja' ? 'numeric' : 'short', day: 'numeric' }).format(ms);
}
