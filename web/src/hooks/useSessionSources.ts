import { useMemo } from 'react';

import type { LiveSource } from '@/protocol';
import { type ListedSource, listSources } from '@/sources';
import { useAppStore } from '@/store';
import type { Session } from '@/types';

const NO_SOURCES: LiveSource[] = [];

// 開いているセッションの音源（#357。音源が 1 つなら空）。録音中は sources のメッセージ、録音を終えたらフロントマター
export function useSessionSources(session: Session | undefined): ListedSource[] {
    const live = useAppStore((s) => (session ? s.liveSources[session.id] : undefined) ?? NO_SOURCES);
    const stored = session?.sources;
    const recording = session?.status === 'recording';
    const has = session !== undefined;
    // 行の札の名前の表が毎回変わると、行（memo）が全部描き直されるので、元が変わったときだけ作り直す。
    // 録音を終えたあとも、フロントマターを読み直すまでは録音中に届いた一覧を使う
    return useMemo(() => (has ? listSources(stored, live, recording) : []), [has, stored, live, recording]);
}
