import { sessionMessages } from '@/features/session/i18n';
import { sourceColor, sourceLabel, sourceTitle } from '@/features/session/sources';
import { useT } from '@/i18n/messages';

// 行の音源の札（音源が 2 つ以上のセッションだけ。#357。spec/ui.md 8）。話者の札と取り違えないよう枠線の丸にする。
// 置き換え（#176）で選ぶ文字には入れない
export function SourceBadge({ id, name }: { id: number; name?: string | null }) {
    // 音源の文は sources.ts で引くので、表示言語を切り替えたら描き直すために購読する
    useT(sessionMessages);
    const title = sourceTitle(id, name);
    return (
        <span
            role='img'
            title={title}
            aria-label={title}
            className={`mt-0.5 inline-flex h-5 shrink-0 items-center self-start rounded-full border px-1.5 text-xs whitespace-nowrap tabular-nums ${sourceColor(id)}`}
        >
            {sourceLabel(id)}
        </span>
    );
}
