// サーバーに届いていない音声を IndexedDB に置いておく（#102。spec/flows.md 6.7）
// ページを読み込み直しても（スマホでタブが落とされても）、溜めていた音声が失われないようにする。
// 送ったチャンクは、サーバーが受け取った（ack）ら消す。IndexedDB が使えないブラウザでは何もしない
import { SAMPLE_RATE } from '@/audio/microphone';

const DB_NAME = 'remote-whisper';
const CHUNKS = 'unsentChunks';
// 置いておく量の上限（バイト）。16kHz・Int16 で約 60 分。超えた分は手元（メモリ）だけに持つ
export const MAX_BYTES = 120 * 1024 * 1024;

// host は録音していたホストの ID（クラウド版。#227）。ダイレクト版は null。
// #227 より前に置いた行には host がない（undefined）。扱いは splitByHost を見る。
// キーや索引は変えないので、データベースの版は上げない
type ChunkRow = { session: string; seq: number; project: string; host?: string | null; frame: ArrayBuffer };
export type UnsentSession = {
    session: string;
    project: string;
    host?: string | null;
    frames: { seq: number; frame: ArrayBuffer }[];
};
// ほかのホストに残っている音声（ホストごと）。host が null は、どのホストのものか分からないもの
// （クラウド版で、ホスト ID のない古い行と、host が null の行）
export type UnsentElsewhere = { host: string | null; sessions: string[]; seconds: number };

// 溜めていた音声の長さ（秒）。チャンクは先頭 4 バイトが連番、あとは 16kHz・Int16
export function unsentSeconds(frames: { frame: ArrayBuffer }[]) {
    const samples = frames.reduce((n, f) => n + (f.frame.byteLength - 4) / 2, 0);
    return Math.round(samples / SAMPLE_RATE);
}

// 今つないでいるホスト（ダイレクト版は null）のものと、ほかのホストのものに分ける（#227）。
// 今のホストのものは、復旧できる最初の 1 つだけを返す（それまでと同じ）
// - ダイレクト版（current が null）: ホスト ID のない古い行も null の行も、今のホストのもの
//   （ダイレクト版はホストのアドレスで開くので、IndexedDB にはそのホストの行しかない）
// - クラウド版: ホスト ID のない古い行と null の行は、どのホストのものか分からないので今のホストに送らない。
//   host を null にして返し、捨てられるようにする（同じブラウザで別のアカウントがログインしたとき、
//   前の人の録音を今の人のホストに送らないため。spec/cloud.md 10.6）
export function splitByHost(
    list: UnsentSession[],
    current: string | null,
): { mine: UnsentSession | null; elsewhere: UnsentElsewhere[] } {
    let mine: UnsentSession | null = null;
    const byHost = new Map<string | null, UnsentElsewhere>();
    for (const entry of list) {
        if (entry.frames.length === 0) {
            continue;
        }
        const host = entry.host ?? null;
        if (host === current) {
            mine ??= entry;
            continue;
        }
        const e = byHost.get(host) ?? { host, sessions: [], seconds: 0 };
        e.sessions.push(entry.session);
        e.seconds += unsentSeconds(entry.frames);
        byHost.set(host, e);
    }
    return { mine, elsewhere: [...byHost.values()] };
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
    if (!opening) {
        opening = new Promise((resolve) => {
            try {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    req.result.createObjectStore(CHUNKS, { keyPath: ['session', 'seq'] });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    return opening;
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

// 置いた量（バイト）。セッションごと
const sizes = new Map<string, number>();

// 読み込み直した後、IndexedDB に置いてあった量から数え直す（上限を守るため）
export function restoreSize(session: string, frames: { frame: ArrayBuffer }[]) {
    sizes.set(
        session,
        frames.reduce((n, f) => n + f.frame.byteLength, 0),
    );
}

// チャンク（先頭4バイトが連番の、送るときの形）を置く。上限を超えたら置かずに false
// host は今つないでいるホスト（ダイレクト版は null。#227）
export async function saveChunk(
    session: string,
    project: string,
    host: string | null,
    seq: number,
    frame: ArrayBuffer,
) {
    const size = (sizes.get(session) ?? 0) + frame.byteLength;
    if (size > MAX_BYTES) {
        return false;
    }
    sizes.set(session, size);
    const db = await open();
    if (!db) {
        return true;
    }
    try {
        const tx = db.transaction(CHUNKS, 'readwrite');
        tx.objectStore(CHUNKS).put({ session, seq, project, host, frame } satisfies ChunkRow);
        await done(tx);
    } catch {
        // 容量が足りないなど。手元（メモリ）には残っている
    }
    return true;
}

// サーバーが受け取った（seq まで）チャンクを消す
export async function deleteUpTo(session: string, seq: number) {
    const db = await open();
    if (!db) {
        return;
    }
    try {
        const tx = db.transaction(CHUNKS, 'readwrite');
        const store = tx.objectStore(CHUNKS);
        const range = IDBKeyRange.bound([session, -Infinity], [session, seq]);
        const cursor = store.openCursor(range);
        cursor.onsuccess = () => {
            const c = cursor.result;
            if (c) {
                sizes.set(session, Math.max(0, (sizes.get(session) ?? 0) - (c.value as ChunkRow).frame.byteLength));
                c.delete();
                c.continue();
            }
        };
        await done(tx);
    } catch {
        // 次の ack で消す
    }
}

// セッションのチャンクをすべて消す（送り終えた・捨てた・続きの頭に回した）
export async function clearSession(session: string) {
    sizes.delete(session);
    const db = await open();
    if (!db) {
        return;
    }
    try {
        const tx = db.transaction(CHUNKS, 'readwrite');
        tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([session, -Infinity], [session, Infinity]));
        await done(tx);
    } catch {
        // そのまま残る（次に読み込んだときに、もう一度聞く）
    }
}

// 置いてあるチャンクを、セッションごとに連番の順で返す
export async function listUnsent(): Promise<UnsentSession[]> {
    const db = await open();
    if (!db) {
        return [];
    }
    try {
        const tx = db.transaction(CHUNKS, 'readonly');
        const req = tx.objectStore(CHUNKS).getAll();
        const rows = await new Promise<ChunkRow[]>((resolve) => {
            req.onsuccess = () => resolve(req.result as ChunkRow[]);
            req.onerror = () => resolve([]);
        });
        // ホストはセッションの最初の行のものを使う。録音中はホストを切り替えられず（spec/cloud.md 10.6）、
        // 切り替えると読み込み直すので、同じセッションの行でホストが違うことは起きない前提。
        // 復旧はそのホストにつないでいるときだけなので、続きの行も同じホストになる
        // （ダイレクト版で古い行を復旧すると null の行が続くが、ダイレクト版ではどちらも今のホストのもの）
        const bySession = new Map<string, UnsentSession>();
        for (const row of rows) {
            const entry = bySession.get(row.session) ?? {
                session: row.session,
                project: row.project,
                host: row.host,
                frames: [],
            };
            entry.frames.push({ seq: row.seq, frame: row.frame });
            bySession.set(row.session, entry);
        }
        return [...bySession.values()].map((e) => ({ ...e, frames: e.frames.sort((a, b) => a.seq - b.seq) }));
    } catch {
        return [];
    }
}
