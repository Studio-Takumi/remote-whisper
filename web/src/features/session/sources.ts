// 複数の音源（#241・#357。spec/flows.md 6.16・spec/ui.md 8）。音源が 2 つ以上のセッションだけで使う。
// 音源と話者は別のもの（1 つのマイクが複数の人を拾い、同じ人を複数のマイクが拾う）なので、音源から話者を決めない
import type { LiveSource } from '@/api/protocol';
import type { TranscriptLine } from '@/api/types';
import { sessionMessages } from '@/features/session/i18n';
import { formatClock } from '@/lib/time';

// 文字起こしのフロントマターの音源（spec/files.md 5.5 節の sources）。1 つ目が主の音源
export type SessionSource = {
    id: number;
    name: string | null;
    kind: 'main' | 'join' | 'upload';
    recording?: string | null;
    offsetSec?: number;
    driftPpm?: number;
    // 参加した・抜けた時刻（主の音源の時刻。join だけ）
    joinedSec?: number | null;
    leftSec?: number | null;
};

// 一覧に出す音源。stored は録音を終えたもの（フロントマター）、live は録音中のもの（sources のメッセージ）
export type ListedSource = { id: number; name: string | null; kind: SessionSource['kind'] } & (
    { live: false; joinedSec?: number | null; leftSec?: number | null } | { live: true; state: LiveSource['state'] }
);

// 行の音源（lineSources）を行に付ける。行の数より短ければ、足りない行は主の音源（1）とみなす（spec/flows.md 6.16）。
// ない・空なら付けない（音源が 1 つのセッション）
export function withLineSources<T extends { time: string; text: string }>(
    lines: T[],
    lineSources: number[] | null | undefined,
): (T & { source?: number })[] {
    if (!lineSources || lineSources.length === 0) {
        return lines;
    }
    return lines.map((line, i) => ({ ...line, source: lineSources[i] ?? 1 }));
}

// 取り直した行に音源がなければ（録音中はフロントマターにまだない）、手元の同じ行の音源を残す
export function keepLineSources(fetched: TranscriptLine[], local: TranscriptLine[]): TranscriptLine[] {
    if (fetched.some((l) => l.source !== undefined) || !local.some((l) => l.source !== undefined)) {
        return fetched;
    }
    return fetched.map((line, i) =>
        local[i]?.source !== undefined && local[i].time === line.time ? { ...line, source: local[i].source } : line,
    );
}

// 行に付ける札の文字（「音源 2」）と、名前つきの説明（title と読み上げ。「音源 2（iPhone）」）
export function sourceLabel(id: number) {
    return sessionMessages.t('sources.label', { n: id });
}

export function sourceTitle(id: number, name: string | null | undefined) {
    return name ? sessionMessages.t('sources.titleNamed', { n: id, name }) : sourceLabel(id);
}

// 音源ごとの色。話者の札（塗りの四角）とは形を分け、枠線の丸い札にする（音源は話者ではない）
const SOURCE_COLORS = [
    'border-slate-400/70 text-slate-700 dark:border-slate-400/60 dark:text-slate-300',
    'border-teal-500/70 text-teal-700 dark:border-teal-400/60 dark:text-teal-300',
    'border-violet-500/70 text-violet-700 dark:border-violet-400/60 dark:text-violet-300',
    'border-orange-500/70 text-orange-700 dark:border-orange-400/60 dark:text-orange-300',
    'border-lime-600/70 text-lime-800 dark:border-lime-400/60 dark:text-lime-300',
    'border-pink-500/70 text-pink-700 dark:border-pink-400/60 dark:text-pink-300',
];

export function sourceColor(id: number) {
    return SOURCE_COLORS[(Math.max(1, id) - 1) % SOURCE_COLORS.length];
}

// 音源の種類（録音した端末 / 参加した端末 / ファイル）。アップロードで作ったセッションの主の音源はファイル
export function sourceKindLabel(kind: SessionSource['kind'], uploaded: boolean) {
    if (kind === 'join') {
        return sessionMessages.t('sources.kindJoin');
    }
    if (kind === 'upload' || uploaded) {
        return sessionMessages.t('sources.kindFile');
    }
    return sessionMessages.t('sources.kindRecorder');
}

const LIVE_STATE_KEYS = {
    active: 'sources.stateConnected',
    disconnected: 'sources.stateDisconnected',
    left: 'sources.stateLeft',
} as const;

export function liveStateLabel(state: LiveSource['state']): string {
    return sessionMessages.t(LIVE_STATE_KEYS[state]);
}

// 参加していた時間（主の音源の時刻）。録音中の音源はつながっているか
export function describeSourceSpan(source: ListedSource, durationSec: number | undefined, uploaded: boolean) {
    if (source.live) {
        return liveStateLabel(source.state);
    }
    if (source.kind === 'upload' || uploaded) {
        return sessionMessages.t('sources.spanFile');
    }
    const end = (sec: number | null | undefined) =>
        sec != null
            ? formatClock(sec)
            : durationSec !== undefined
              ? formatClock(durationSec)
              : sessionMessages.t('sources.spanUntilEnd');
    if (source.kind === 'main') {
        return sessionMessages.t('sources.spanRange', { start: '00:00:00', end: end(undefined) });
    }
    return sessionMessages.t('sources.spanRange', {
        start: formatClock(source.joinedSec ?? 0),
        end: end(source.leftSec),
    });
}

// セッションの音源の一覧。録音中は sources のメッセージで届いたもの、録音を終えたらフロントマターのもの。
// 音源が 1 つなら空（音源が 1 つのセッションの見た目は変えない）
export function listSources(
    stored: SessionSource[] | undefined,
    live: LiveSource[] | undefined,
    recording: boolean,
): ListedSource[] {
    if ((recording || !stored) && live && live.length >= 2) {
        return live.map((s) => ({ id: s.id, name: s.name, kind: s.kind, live: true, state: s.state }));
    }
    if (stored && stored.length >= 2) {
        return stored.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            live: false,
            joinedSec: s.joinedSec,
            leftSec: s.leftSec,
        }));
    }
    return [];
}

// 音源 ID から名前を引く表（行の札の title に使う）
export function sourceNames(sources: { id: number; name: string | null }[]): Record<number, string | null> {
    return Object.fromEntries(sources.map((s) => [s.id, s.name]));
}

// 新しく切れた音源（録音している端末でトーストを出す）。前に知らなかった音源は数えない
export function newlyDisconnected(before: LiveSource[] | undefined, after: LiveSource[]): LiveSource[] {
    if (!before) {
        return [];
    }
    return after.filter((s) => s.state === 'disconnected' && before.find((b) => b.id === s.id)?.state === 'active');
}

// 複数のファイルを「1 つのセッションにまとめる」を押せないときの理由。押せるなら null（spec/api.md 7.1）
export function mergeUnavailable(fileCount: number, maxSources: number | undefined): string | null {
    if (maxSources === undefined) {
        return sessionMessages.t('sources.mergeNoMulti');
    }
    if (maxSources < 2) {
        return sessionMessages.t('sources.mergeNotAllowed');
    }
    if (fileCount > maxSources) {
        return sessionMessages.t('sources.mergeLimit', { n: maxSources });
    }
    return null;
}
