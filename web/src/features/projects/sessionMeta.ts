import type { Session } from '@/api/types';
import { formatElapsed, formatShortDateTime, sessionDuration } from '@/lib/time';

// 録音日時と長さ（例: 10/11 14:05 · 1:23:45）。録音中は長さの代わりに「録音中」
export function sessionMeta(session: Session) {
    const started = formatShortDateTime(session.startedAt);
    if (session.status === 'recording') {
        return `${started} · 録音中`;
    }
    const duration = sessionDuration(session);
    return duration === undefined ? started : `${started} · ${formatElapsed(Math.round(duration))}`;
}
