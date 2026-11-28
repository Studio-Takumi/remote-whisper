// 文字起こし・要約・タイトルなど、ユーザーの言葉を出す要素に付ける lang（#497）。
// <html lang> は表示言語なので、英語の表示の下の日本語は、ブラウザによって（Windows の Chrome など）
// 中国語の字形のフォントになる。中身に仮名か漢字があれば ja を付け、なければ付けない（親の lang のまま）。
// セッションの文字起こしの言語は画面に届いていない（要約・タイトルは要約の言語で書かれることもある）ので、中身から決める
// 平仮名・片仮名（中黒の U+30FB は除く）・漢字・半角片仮名
const CJK = /[ぁ-ゟァ-ヺー-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

// 長い要約でも先頭だけを見る（言語が途中で替わることはまずない）
const SCAN = 2000;

export function contentLang(...texts: (string | null | undefined)[]): 'ja' | undefined {
    return texts.some((text) => !!text && CJK.test(text.slice(0, SCAN))) ? 'ja' : undefined;
}
