// 録音中・見ている録音に届く、セッションの中身を変えるメッセージ（partial・final・terms・途中の要約。spec/api.md 7.2）。
// 自分の録音（subscribeRecording）と watch（receiveWatched）で同じものを使う
import type { ServerMessage } from '@/api/protocol';
import type { Project } from '@/api/types';
import { updateSession } from '@/features/projects/updateSession';
import { type LivePartial, dropPartial, upsertPartial } from '@/features/session/livePartials';
import { formatClock } from '@/lib/time';

export type LiveDraft = { sessionId: string; text: string };
export type LiveState = { projects: Project[]; partials: LivePartial[]; liveDraft: LiveDraft | null };

type Live<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
export type LiveMessage = Live<'partial' | 'final' | 'terms' | 'summary.delta' | 'summary.done'>;

export function isLiveMessage(m: ServerMessage): m is LiveMessage {
    if (m.type === 'summary.delta' || m.type === 'summary.done') {
        return m.kind === 'live';
    }
    return m.type === 'partial' || m.type === 'final' || m.type === 'terms';
}

// 届いた partial・final から、画面で持つ形にする（source は音源が 2 つ以上のときだけ来る。#356）
function partialFrom(m: Live<'partial'>): LivePartial {
    const partial: LivePartial = {
        sessionId: m.session,
        segment: m.segment,
        committed: m.committed,
        tentative: m.tentative,
    };
    if (m.source !== undefined) {
        partial.source = m.source;
    }
    return partial;
}

function lineFrom(m: Live<'final'>) {
    const line: { time: string; text: string; source?: number } = { time: formatClock(m.start), text: m.text };
    if (m.source !== undefined) {
        line.source = m.source;
    }
    return line;
}

// final は区間全体の文字起こしで、partial を置き換える。text が空なら文字にならなかった区間なので、partial を消すだけ（#89）
function applyFinal(s: LiveState, m: Live<'final'>): Partial<LiveState> {
    const line = lineFrom(m);
    return {
        projects: m.text
            ? updateSession(s.projects, m.session, (x) => ({ ...x, transcript: [...x.transcript, line] }))
            : s.projects,
        partials: dropPartial(s.partials, m.session, m.segment),
    };
}

// 途中の要約は毎回まるごと作り直される。replace（前置き・できあがった全体）は下書きを置き換える（#123）。
// 回の始まりを受けていない続き（つながり直した直後など）は、断片だけが出ないように捨てる
function applyDelta(s: LiveState, m: Live<'summary.delta'>): Partial<LiveState> | null {
    const same = s.liveDraft?.sessionId === m.session;
    if (!m.replace && !same) {
        return null;
    }
    const before = !m.replace && same ? (s.liveDraft?.text ?? '') : '';
    return { liveDraft: { sessionId: m.session, text: before + m.text } };
}

// 下書きをセッションに入れて消す。下書きがほかのセッションのもの（録音しながら見ているもの）なら残す
function applyDone(s: LiveState, m: Live<'summary.done'>): Partial<LiveState> {
    const draft = s.liveDraft;
    if (draft?.sessionId !== m.session) {
        return { projects: s.projects, liveDraft: draft };
    }
    return {
        projects: updateSession(s.projects, m.session, (x) => ({ ...x, liveSummary: draft.text })),
        liveDraft: null,
    };
}

// 今の状態とメッセージから、変わる部分を返す。何も変えないときは null
export function applyLiveMessage(s: LiveState, m: LiveMessage): Partial<LiveState> | null {
    switch (m.type) {
        case 'partial':
            return { partials: upsertPartial(s.partials, partialFrom(m)) };
        case 'final':
            return applyFinal(s, m);
        case 'terms':
            // 録音中に拾った語が変わった（#103）
            return {
                projects: updateSession(s.projects, m.session, (x) => ({
                    ...x,
                    pickedTerms: m.terms,
                    manualTerms: m.manual ?? x.manualTerms,
                })),
            };
        case 'summary.delta':
            return m.kind === 'live' ? applyDelta(s, m) : null;
        case 'summary.done':
            return m.kind === 'live' ? applyDone(s, m) : null;
    }
}
