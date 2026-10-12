// サーバーに届いていない音声を IndexedDB に置いておく（#102。spec 6.7）
// ページを読み込み直しても（スマホでタブが落とされても）、溜めていた音声が失われないようにする。
// 送ったチャンクは、サーバーが受け取った（ack）ら消す。IndexedDB が使えないブラウザでは何もしない

const DB_NAME = 'remote-whisper';
const CHUNKS = 'unsentChunks';
// 置いておく量の上限（バイト）。16kHz・Int16 で約 60 分。超えた分は手元（メモリ）だけに持つ
export const MAX_BYTES = 120 * 1024 * 1024;

type ChunkRow = { session: string; seq: number; project: string; frame: ArrayBuffer };
export type UnsentSession = { session: string; project: string; frames: { seq: number; frame: ArrayBuffer }[] };

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

// チャンク（先頭4バイトが連番の、送るときの形）を置く。上限を超えたら置かずに false
export async function saveChunk(session: string, project: string, seq: number, frame: ArrayBuffer) {
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
        tx.objectStore(CHUNKS).put({ session, seq, project, frame } satisfies ChunkRow);
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
        const bySession = new Map<string, UnsentSession>();
        for (const row of rows) {
            const entry = bySession.get(row.session) ?? { session: row.session, project: row.project, frames: [] };
            entry.frames.push({ seq: row.seq, frame: row.frame });
            bySession.set(row.session, entry);
        }
        return [...bySession.values()].map((e) => ({ ...e, frames: e.frames.sort((a, b) => a.seq - b.seq) }));
    } catch {
        return [];
    }
}
