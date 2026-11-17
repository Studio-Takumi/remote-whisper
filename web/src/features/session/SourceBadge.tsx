import { sourceColor, sourceLabel, sourceTitle } from '@/features/session/sources';

// 行の音源の札（音源が 2 つ以上のセッションだけ。#357）。どの音源の声として文字になったか。
// 話者の札（塗りの四角）と取り違えないよう、枠線の丸い札にする（音源は話者ではない）。
// 時刻の横に置き、置き換え（#176）で選ぶ文字には入れない
export function SourceBadge({ id, name }: { id: number; name?: string | null }) {
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
