// 文字起こしの置き換え（#176）。数え方・置き換え方は、サーバー（corrections.py）と合わせる
import { termProblem } from '@/features/session/terms';

// 「この行だけ」の行。index は画面に出す行の番号（0 から）。generation は最終の文字起こしの版
export type CorrectionLine = { transcript: 'live' | 'final'; generation?: string | null; index: number };

export type Correction = { from: string; to: string; line: CorrectionLine | null };

// 間違った文字列の長さ（文字）の上限
export const CORRECTION_MAX_CHARS = 80;

// text の中の wrong を right にする。すでに right になっているところと重なる wrong
// （「高橋」→「高橋健」の「高橋健」の頭、「田健」→「高田健」の「高田健」の中）は置き換えない
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
    // すでに正しい語になっているところ
    const kept = new Array<boolean>(text.length).fill(false);
    for (let at = text.indexOf(right); at !== -1; at = text.indexOf(right, at + right.length)) {
        kept.fill(true, at, at + right.length);
    }
    let out = '';
    let n = 0;
    let i = 0;
    while (i < text.length) {
        if (text.startsWith(wrong, i) && !kept.slice(i, i + wrong.length).includes(true)) {
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

// 浄書の行の話者の札（#121）。置き換えは札には当てない
const SPEAKER_RE = /^話者 \d+: /;

function splitLabel(text: string): [string, string] {
    const label = SPEAKER_RE.exec(text)?.[0] ?? '';
    return [label, text.slice(label.length)];
}

// 1 行に当てる（話者の札を除いて）
export function replaceLine(text: string, wrong: string, right: string): string {
    const [label, body] = splitLabel(text);
    return label + replace(body, wrong, right);
}

// 行の一覧の中で置き換わる箇所の数（話者の札は数えない）
export function countInLines(lines: { text: string }[], wrong: string, right: string): number {
    return lines.reduce((n, line) => n + count(splitLabel(line.text)[1], wrong, right), 0);
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

// 録音中に取り直した文字起こし（fetched）を手元の行（local）に重ねる。final と取り直しのどちらが先でも
// 二重・抜けにならないよう、手元の行の数を正にして本文だけ差し替える（spec/notes.md 9.5）
export function mergeLiveLines<T extends { time: string; text: string }>(local: T[], fetched: T[]): T[] {
    return local.map((line, i) =>
        fetched[i] && fetched[i].text !== line.text ? { ...line, text: fetched[i].text } : line,
    );
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
                ? { ...line, text: replaceLine(line.text, c.from, c.to) }
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

type Line = { time: string; text: string };

// 置き換えた行（applied）のうち、今もそのままの行だけを置き換える前（before）に戻す
function revertLines<L extends Line>(now: L[], before: Line[], applied: Line[]): L[] {
    return now.map((line, i) =>
        before[i] && applied[i] && applied[i].text !== before[i].text && line.text === applied[i].text
            ? { ...line, text: before[i].text }
            : line,
    );
}

// 置き換え（手元で当てたもの）を戻す。待っている間に届いた行・ほかの置き換えで変わった行は、そのまま残す（#361）
export function revertCorrection<T extends CorrectableSession>(now: T, before: T, applied: T): T {
    const final = now.finalTranscript;
    const sameFinal =
        final &&
        final.generationId === before.finalTranscript?.generationId &&
        final.generationId === applied.finalTranscript?.generationId;
    return {
        ...now,
        transcript: now.transcript && revertLines(now.transcript, before.transcript ?? [], applied.transcript ?? []),
        finalTranscript:
            sameFinal && before.finalTranscript && applied.finalTranscript
                ? {
                      ...final,
                      lines: revertLines(final.lines, before.finalTranscript.lines, applied.finalTranscript.lines),
                  }
                : final,
    };
}

// 用語の欄に出す説明（「この行だけ」のときは、どの行か）
export function describeCorrection(c: Correction): string {
    const where = c.line
        ? `（${c.line.transcript === 'final' ? '浄書' : 'リアルタイム'}の ${c.line.index + 1} 行目だけ）`
        : '';
    return `${c.from} → ${c.to}${where}`;
}
