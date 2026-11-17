// 用語の入力を、足す語に分ける・確かめる（#175）。サーバーの検証（routes/sessions.py の add_term）と合わせる

// 手で足す語の長さ（文字）の上限
export const MANUAL_MAX_CHARS = 40;

// 入力を、改行で分け、前後の空白と空の行は捨てる。同じ語は 1 回だけにする。
// 「、」は用語リストの区切りなので、ここでも区切りとして扱う
export function splitTerms(text: string): string[] {
    const terms = text
        .split(/[\r\n、]+/)
        .map((t) => t.trim())
        .filter((t) => t !== '');
    return [...new Set(terms)];
}

// 足せない語なら、その理由。足せるなら null
export function termProblem(term: string): string | null {
    if (term.length > MANUAL_MAX_CHARS) {
        return `${MANUAL_MAX_CHARS} 文字を超えています`;
    }
    if (term.includes('/')) {
        return '「/」は使えません';
    }
    return null;
}

export type ParsedTerms = { valid: string[]; invalid: { term: string; reason: string }[] };

// 入力を、足せる語と足せない語（理由つき）に分ける
export function parseTermInput(text: string): ParsedTerms {
    const parsed: ParsedTerms = { valid: [], invalid: [] };
    for (const term of splitTerms(text)) {
        const reason = termProblem(term);
        if (reason) {
            parsed.invalid.push({ term, reason });
        } else {
            parsed.valid.push(term);
        }
    }
    return parsed;
}

// 入力欄に残す語（足せなかった語）。1 行の入力欄なので「、」でつなぐ
export function remainingDraft(terms: string[]): string {
    return terms.join('、');
}

// 足せなかった理由の表示（長い語は先頭だけ出す）
export function describeInvalid(invalid: ParsedTerms['invalid']): string {
    return invalid
        .map(({ term, reason }) => `「${term.length > 12 ? `${term.slice(0, 12)}…` : term}」: ${reason}`)
        .join(' / ');
}

// Enter で足すか。日本語入力の変換を確定する Enter では足さない
export function isSubmitKey(e: { key: string; isComposing: boolean }): boolean {
    return e.key === 'Enter' && !e.isComposing;
}

// 語を順に足す（足し方は add に任せる）。足せた語と足せなかった語を返す
export async function addAll(
    terms: string[],
    add: (term: string) => Promise<boolean>,
): Promise<{ added: string[]; failed: string[] }> {
    const added: string[] = [];
    const failed: string[] = [];
    for (const term of terms) {
        if (await add(term)) {
            added.push(term);
        } else {
            failed.push(term);
        }
    }
    return { added, failed };
}
