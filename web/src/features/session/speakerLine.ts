// 最終の文字起こし（#121）で話者を分けた行は「話者 1: …」で始まる。話者は色付きの札にする（#146）
const SPEAKER_RE = /^話者 (\d+): (.*)$/s;
const SPEAKER_COLORS = [
    'bg-sky-500/15 text-sky-800 dark:text-sky-300',
    'bg-amber-500/15 text-amber-800 dark:text-amber-300',
    'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
    'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
    'bg-rose-500/15 text-rose-800 dark:text-rose-300',
    'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
];

// 話者の番号（文字のまま）と本文に分ける。話者の付いていない行は null
export function parseSpeaker(text: string): { speaker: string; text: string } | null {
    const m = SPEAKER_RE.exec(text);
    return m ? { speaker: m[1], text: m[2] } : null;
}

// 話者の札の色。6 色を順に使い回す
export function speakerColor(speaker: string): string {
    return SPEAKER_COLORS[(Number(speaker) - 1) % SPEAKER_COLORS.length];
}
