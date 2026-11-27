import { useAppStore } from '@/app/store';
import { sessionMessages } from '@/features/session/i18n';
import { parseSpeaker, speakerColor } from '@/features/session/speakerLine';
import { useT } from '@/i18n/messages';

// 行の本文。置き換え（#176）に使えるのは data-correctable の中の文字だけ（時刻と話者の札は選んでも使わない）
export function LineText({ text }: { text: string }) {
    const t = useT(sessionMessages);
    // 全体設定の display.showSpeakers（#146）がオフなら、札は出さず文だけを出す
    const showSpeakers = useAppStore((s) => s.settings.display.showSpeakers ?? false);
    const parsed = parseSpeaker(text);
    if (!parsed) {
        return (
            <p className='leading-6'>
                <span data-correctable>{text}</span>
            </p>
        );
    }
    if (!showSpeakers) {
        return (
            <p className='leading-6'>
                <span data-correctable>{parsed.text}</span>
            </p>
        );
    }
    return (
        <p className='leading-6'>
            <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${speakerColor(parsed.speaker)}`}>
                {t('lineText.speaker', { n: parsed.speaker })}
            </span>
            <span data-correctable>{parsed.text}</span>
        </p>
    );
}
