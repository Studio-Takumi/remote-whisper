// 用語の入力を、足す語に分ける（#175）。改行で分け、前後の空白と空の行は捨てる。
// 同じ語は 1 回だけにする。「、」は用語リストの区切りなので、ここでも区切りとして扱う
export function splitTerms(text: string): string[] {
    const terms = text
        .split(/[\r\n、]+/)
        .map((t) => t.trim())
        .filter((t) => t !== '');
    return [...new Set(terms)];
}
