import { useAppStore } from '@/app/store';

// 置き換え（#176）に使えるのは data-correctable の中の文字だけ（時刻と話者の札は選んでも使わない）
// 最終の文字起こし（#121）で話者を分けた行は「話者 1: …」で始まる。話者は色付きの札にする
const SPEAKER_RE = /^話者 (\d+): (.*)$/s;
const SPEAKER_COLORS = [
    'bg-sky-500/15 text-sky-800 dark:text-sky-300',
    'bg-amber-500/15 text-amber-800 dark:text-amber-300',
    'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
    'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
    'bg-rose-500/15 text-rose-800 dark:text-rose-300',
    'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
];

export function LineText({ text }: { text: string }) {
    // 全体設定の display.showSpeakers（#146）がオフなら、札は出さず文だけを出す
    const showSpeakers = useAppStore((s) => s.settings.display.showSpeakers ?? false);
    const m = SPEAKER_RE.exec(text);
    if (!m) {
        return (
            <p className='leading-6'>
                <span data-correctable>{text}</span>
            </p>
        );
    }
    if (!showSpeakers) {
        return (
            <p className='leading-6'>
                <span data-correctable>{m[2]}</span>
            </p>
        );
    }
    const color = SPEAKER_COLORS[(Number(m[1]) - 1) % SPEAKER_COLORS.length];
    return (
        <p className='leading-6'>
            <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${color}`}>話者 {m[1]}</span>
            <span data-correctable>{m[2]}</span>
        </p>
    );
}
