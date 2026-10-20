import { describe, expect, it } from 'vitest';

import { mergeProjects, pickFinalTranscript } from '@/data';
import type { FinalTranscriptInfo, Project, Session } from '@/types';

function info(generationId: string, model: string): FinalTranscriptInfo {
    return { generationId, model, generatedAt: '', diarization: 'off', speakers: 0 };
}

describe('pickFinalTranscript', () => {
    const infos = [info('g1', 'turbo'), info('g2', 'small'), info('g3', 'turbo'), info('g4', 'small')];

    it('今の Whisper のモデルで作ったうち、いちばん新しいもの', () => {
        expect(pickFinalTranscript(infos, 'turbo')?.generationId).toBe('g3');
    });

    it('そのモデルのものがなければ、モデルを問わずいちばん新しいもの', () => {
        expect(pickFinalTranscript(infos, 'large-v3')?.generationId).toBe('g4');
    });

    it('版がなければない', () => {
        expect(pickFinalTranscript([], 'turbo')).toBeUndefined();
    });
});

function session(id: string, extra: Partial<Session> = {}): Session {
    return {
        id,
        title: id,
        startedAt: '2026-10-01 09:00',
        status: 'done',
        files: { recording: true, transcript: true, summaries: 1, liveSummary: false },
        transcript: [],
        summaries: [],
        ...extra,
    };
}

function project(sessions: Session[]): Project {
    return { id: 'p', name: 'p', path: '', sessions };
}

describe('mergeProjects', () => {
    const loaded = session('s1', { loaded: true, transcript: [{ time: '00:00:01', text: 'こんにちは' }] });

    it('ファイルが変わっていなければ、前に取った中身を使う', () => {
        const [p] = mergeProjects([project([loaded])], [project([session('s1')])], new Set());
        expect(p.sessions[0].loaded).toBe(true);
        expect(p.sessions[0].transcript).toEqual(loaded.transcript);
    });

    it('ファイルが増えたものは取り直す', () => {
        const next = session('s1', { files: { recording: true, transcript: true, summaries: 2, liveSummary: false } });
        const [p] = mergeProjects([project([loaded])], [project([next])], new Set());
        expect(p.sessions[0].loaded).toBeUndefined();
        expect(p.sessions[0].transcript).toEqual([]);
    });

    it('録音中だったものは取り直す', () => {
        const recording = { ...loaded, status: 'recording' as const };
        const [p] = mergeProjects([project([recording])], [project([session('s1')])], new Set());
        expect(p.sessions[0].loaded).toBeUndefined();
    });

    it('手元で積み上げているものは手元のまま。サーバーの一覧になければ足す', () => {
        const local = session('s0', { status: 'recording', transcript: [{ time: '00:00:01', text: '録音中' }] });
        const [p] = mergeProjects([project([local, loaded])], [project([session('s1')])], new Set(['s0']));
        expect(p.sessions.map((s) => s.id)).toEqual(['s0', 's1']);
        expect(p.sessions[0]).toBe(local);
    });
});
