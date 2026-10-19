// 文字起こしの置き換え（#176）。数え方・置き換え方は、サーバー（corrections.py）と合わせる
import { termProblem } from '@/terms';

// 「この行だけ」の行。index は画面に出す行の番号（0 から）。generation は最終の文字起こしの版
export type CorrectionLine = { transcript: 'live' | 'final'; generation?: string | null; index: number };

export type Correction = { from: string; to: string; line: CorrectionLine | null };

// 間違った文字列の長さ（文字）の上限
export const CORRECTION_MAX_CHARS = 80;

// text の中の wrong を right にする。すでに right になっているところ（wrong が right の頭の部分の
// とき。「岩田」→「岩田匠」など）は、もう一度置き換えない
export function replace(text: string, wrong: string, right: string): string {
    return scan(text, wrong, right).text;
}

// 置き換わる箇所の数
export function count(text: string, wrong: string, right: string): number {
    return scan(text, wrong, right).count;
}

function scan(text: string, wrong: string, right: string) {
    if (!wrong || wrong === right) {
        return { text, count: 0 };
    }
    const skipRight = right.startsWith(wrong);
    let out = '';
    let n = 0;
    let i = 0;
    while (i < text.length) {
        if (skipRight && text.startsWith(right, i)) {
            out += right;
            i += right.length;
        } else if (text.startsWith(wrong, i)) {
            out += right;
            n += 1;
            i += wrong.length;
        } else {
            out += text[i];
            i += 1;
        }
    }
    return { text: out, count: n };
}

// 行の一覧の中で置き換わる箇所の数
export function countInLines(lines: { text: string }[], wrong: string, right: string): number {
    return lines.reduce((n, line) => n + count(line.text, wrong, right), 0);
}

// 選んだ文字列を、間違った文字列として使えるか。使えないなら理由
export function selectionProblem(text: string): string | null {
    if (text.trim() === '') {
        return '文字を選んでください';
    }
    if (/[\r\n]/.test(text)) {
        return '1 行の中で選んでください';
    }
    if (text.length > CORRECTION_MAX_CHARS) {
        return `${CORRECTION_MAX_CHARS} 文字までにしてください`;
    }
    return null;
}

// 正しい語として使えるか。使えないなら理由
export function rightProblem(wrong: string, right: string): string | null {
    if (right === '') {
        return '正しい語を入れてください';
    }
    if (right === wrong) {
        return '選んだ文字列と同じです';
    }
    return termProblem(right);
}

type CorrectableSession = {
    transcript?: { time: string; text: string }[];
    finalTranscript?: { generationId: string; lines: { time: string; text: string }[] };
    manualTerms?: string[];
    corrections?: Correction[];
};

// 置き換えを手元だけで当てる（デモ用。サーバーがあるときは取り直す）
export function applyCorrectionLocally<T extends CorrectableSession>(session: T, c: Correction): T {
    const fix = (lines: { time: string; text: string }[], transcript: 'live' | 'final', generation?: string) =>
        lines.map((line, i) =>
            !c.line ||
            (c.line.transcript === transcript &&
                c.line.index === i &&
                (transcript === 'live' || c.line.generation === generation))
                ? { ...line, text: replace(line.text, c.from, c.to) }
                : line,
        );
    const final = session.finalTranscript;
    return {
        ...session,
        transcript: session.transcript && fix(session.transcript, 'live'),
        finalTranscript: final && { ...final, lines: fix(final.lines, 'final', final.generationId) },
        manualTerms: [...new Set([...(session.manualTerms ?? []), c.to])],
        corrections: [...(session.corrections ?? []).filter((x) => JSON.stringify(x) !== JSON.stringify(c)), c],
    };
}

// 用語の欄に出す説明（「この行だけ」のときは、どの行か）
export function describeCorrection(c: Correction): string {
    const where = c.line
        ? `（${c.line.transcript === 'final' ? '浄書' : 'リアルタイム'}の ${c.line.index + 1} 行目だけ）`
        : '';
    return `${c.from} → ${c.to}${where}`;
}
