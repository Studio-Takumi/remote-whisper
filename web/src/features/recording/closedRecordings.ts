// 録音していたページが閉じられた（アプリを終了した・タブを閉じた）セッションを、つなぎ直すのを待たずに
// 途中で終わったことにする（#448。spec/flows.md 6.7・spec/api.md 7.2）。
// 録音している間は、そのセッションを端末に覚えておき（localStorage）、ページが開いている間はロック（Web Locks）を持つ。
// 開き直したページは、覚えているのにロックが空いている（録音していたページがもうない）セッションを interrupt で終わらせる。
// 電波が切れただけのとき（ページは開いていて音を溜めている）はロックが残るので、今まで通りつなぎ直すのを待つ（#101）
import { toast } from 'sonner';

import { connection } from '@/api/connection';
import { getHostId } from '@/api/endpoint';
import type { ServerMessage } from '@/api/protocol';
import type { AppStore } from '@/app/appState';
import { listUnsent } from '@/features/recording/audio/unsentStore';
import type { Recorder } from '@/features/recording/recorderState';

const KEY = 'rw.recordingSessions';
const LOCK_PREFIX = 'rw.recording:';
// サーバーがまだ前の接続を切っていない（connected が返った）ときに、確かめ直す間隔と回数
export const RETRY_MS = 30000;
const MAX_RETRIES = 4;

// 覚えておくセッション。host は録音していたホスト（クラウド版。セルフホスト版は null。#227）
type Mark = { session: string; host: string | null };
type InterruptReply = Extract<ServerMessage, { type: 'interrupted' } | { type: 'error' }>;

function readMarks(): Mark[] {
    try {
        const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(list) ? list.filter((m): m is Mark => typeof m?.session === 'string') : [];
    } catch {
        return [];
    }
}

function writeMarks(marks: Mark[]) {
    try {
        if (marks.length > 0) {
            localStorage.setItem(KEY, JSON.stringify(marks));
        } else {
            localStorage.removeItem(KEY);
        }
    } catch {
        // 使えないブラウザでは覚えない（今まで通り、時間を過ぎてから終わる）
    }
}

function forget(session: string) {
    writeMarks(readMarks().filter((m) => m.session !== session));
}

// ページが開いている間ロックを持つ。戻り値の関数で放す。Web Locks が使えなければ何もしない
function holdLock(session: string): () => void {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) {
        return () => {};
    }
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    locks.request(LOCK_PREFIX + session, () => held).catch(() => {});
    return release;
}

// ほかのページ（同じ端末の別のタブ）がロックを持っているか。確かめられなければ、持っているとみなす（終わらせない）
async function lockedElsewhere(session: string) {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) {
        return true;
    }
    try {
        const { held = [] } = await locks.query();
        return held.some((lock) => lock.name === LOCK_PREFIX + session);
    } catch {
        return true;
    }
}

// このページで録音しているセッション。切れている間に録音を終えて、まだ stop を送っていないものも含む
export function ownedSession(r: Recorder) {
    return r.store.getState().recordingSessionId ?? r.stoppedWhileOffline;
}

// ページを閉じる（pagehide）。録音中で、届いていない音声がなければ、待たずに終わりにするよう伝える（届けばよい程度。
// スワイプでアプリを終了したときは来ないことがある）。届いていない音声があれば、開き直したときに送って続きを録音
// できるように何も送らない（#102）。戻ってくるかもしれないページ（persisted。bfcache）でも送らない
export function interruptOnPageHide(r: Recorder, persisted: boolean) {
    const s = r.store.getState();
    const session = s.recordingSessionId;
    if (persisted || !session || !r.sender || r.sender.holding || r.resuming || s.pendingAudio > 0) {
        return;
    }
    if (connection.isOpen) {
        connection.send({ type: 'interrupt', session });
    }
}

export class ClosedRecordings {
    // このページで録音しているセッション（覚えてロックを持っているもの）
    private session: string | null = null;
    private release: (() => void) | null = null;
    private running = false;
    private readonly retries = new Map<string, number>();
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    // interrupt の返事を待っている間。古いサーバーが返す bad_message をトーストに出さないため
    waiting = false;

    private readonly store: AppStore;

    constructor(store: AppStore) {
        this.store = store;
    }

    // このページで録音しているセッションが変わった（録音を始めた・終えた）
    track(session: string | null) {
        if (session === this.session) {
            return;
        }
        if (this.session) {
            this.release?.();
            this.release = null;
            forget(this.session);
        }
        this.session = session;
        if (session) {
            writeMarks([...readMarks().filter((m) => m.session !== session), { session, host: getHostId() }]);
            this.release = holdLock(session);
        }
    }

    // つながったとき・届かなかった音声を捨てたときに呼ぶ。録音していたページが閉じられたセッションを終わらせる
    async interruptClosed() {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            const host = getHostId();
            // 届かなかった音声が残っているものは、送って続きを録音できるので待つ（#102。捨てたら終わらせる）
            const unsent = new Set((await listUnsent()).filter((e) => e.frames.length > 0).map((e) => e.session));
            for (const { session } of readMarks().filter((m) => m.host === host)) {
                if (session === this.session || unsent.has(session) || (await lockedElsewhere(session))) {
                    continue;
                }
                await this.interrupt(session);
            }
        } finally {
            this.running = false;
        }
    }

    private async interrupt(session: string) {
        let reply: InterruptReply;
        this.waiting = true;
        try {
            connection.send({ type: 'interrupt', session });
            reply = await connection.waitFor(
                (m): m is InterruptReply =>
                    (m.type === 'interrupted' && m.session === session) || (m.type === 'error' && !m.session),
            );
        } catch {
            // 応答がない。次につながったときに、もう一度確かめる
            return;
        } finally {
            this.waiting = false;
        }
        if (reply.type === 'interrupted' && reply.result === 'connected') {
            // サーバーがまだ前の接続を切っていないかもしれない。少し待ってから確かめ直す
            this.retryLater(session);
            return;
        }
        // 終わった・もう終わっていた・終わらせられない（古いサーバーは interrupt を知らない）
        forget(session);
        this.retries.delete(session);
        if (reply.type === 'interrupted' && reply.result === 'interrupted') {
            toast.error('閉じる前に録音していたセッションを、途中で終わりにしました。そこまでの録音は残っています', {
                duration: 15000,
                action: { label: '続きから録音', onClick: () => void this.store.getState().continueRecording(session) },
            });
        }
    }

    private retryLater(session: string) {
        const count = (this.retries.get(session) ?? 0) + 1;
        this.retries.set(session, count);
        if (count > MAX_RETRIES) {
            // ほかの端末がつなぎ直して録音しているとみなす。覚えるのをやめる
            forget(session);
            this.retries.delete(session);
            return;
        }
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.interruptClosed(), RETRY_MS);
    }
}
