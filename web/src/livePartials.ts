// 文字起こし中の区間（partial。spec/api.md 7.2）。音源が 2 つ以上のセッション（#241・#356）では、
// partial を音源ごとに 1 つずつ持つ。音源が 1 つのとき・古いサーバーでは source が来ないので、1 つだけになる

// committed は確定した部分、tentative はまだ変わるかもしれない部分。source は音源 ID（音源が 2 つ以上のときだけ）
export type LivePartial = {
    sessionId: string;
    segment: number;
    committed: string;
    tentative: string;
    source?: number;
};

// 届いた partial で、同じセッション・同じ音源のものを置き換える
export function upsertPartial(list: LivePartial[], partial: LivePartial): LivePartial[] {
    const rest = list.filter((p) => !(p.sessionId === partial.sessionId && p.source === partial.source));
    return [...rest, partial];
}

// 同じ segment の final が届いた。その partial を消す（segment はセッション全体の通し番号なので、音源は見なくてよい）
export function dropPartial(list: LivePartial[], sessionId: string, segment: number): LivePartial[] {
    const rest = list.filter((p) => !(p.sessionId === sessionId && p.segment === segment));
    return rest.length === list.length ? list : rest;
}

// そのセッションの partial（届いた順）
export function partialsOf(list: LivePartial[], sessionId: string): LivePartial[] {
    return list.filter((p) => p.sessionId === sessionId);
}
