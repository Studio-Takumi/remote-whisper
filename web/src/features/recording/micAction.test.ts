import { describe, expect, it } from 'vitest';

import { type MicSituation, describeJoined, micAction } from '@/features/recording/micAction';

const idle: MicSituation = {
    state: 'idle',
    elsewhere: false,
    recordingTitle: undefined,
    watchedElsewhere: false,
    watchedState: undefined,
    joinedHere: false,
    joinedLabel: '',
    joinReason: undefined,
    continueLeft: null,
    windowMin: 10,
    target: { kind: 'new' },
    micDenied: false,
};

describe('micAction', () => {
    it('待機中は、開いている画面に合わせて録音を始める', () => {
        expect(micAction(idle)).toMatchObject({ do: 'start', label: 'クリックして録音開始', icon: 'mic' });
        expect(micAction({ ...idle, micDenied: true })).toMatchObject({ do: 'start', icon: 'micOff' });
        expect(micAction({ ...idle, target: { kind: 'session', projectName: '講義' } })).toMatchObject({
            do: 'start',
            label: 'クリックして「講義」に新しいセッションを作成',
            icon: 'plus',
        });
        expect(micAction({ ...idle, target: { kind: 'none' } }).color).toContain('cursor-not-allowed');
    });

    it('続きから録音できるあいだは続きから録音する', () => {
        const a = micAction({ ...idle, target: { kind: 'session', projectName: '講義' }, continueLeft: 120 });
        expect(a.do).toBe('continue');
        expect(a.label).toMatch(/^クリックして続きから録音（録音を終えてから 10 分の間は/);
    });

    it('録音中は一時停止、一時停止中は再開。ほかの画面では録音中のセッションに戻る', () => {
        expect(micAction({ ...idle, state: 'recording' })).toMatchObject({ do: 'pause', icon: 'pause' });
        expect(micAction({ ...idle, state: 'paused' })).toMatchObject({ do: 'resume', icon: 'play' });
        expect(micAction({ ...idle, state: 'paused', elsewhere: true, recordingTitle: '第 3 回' })).toMatchObject({
            do: 'back',
            label: '「第 3 回」で一時停止中です。クリックで戻ります',
            color: 'bg-amber-500',
        });
    });

    it('ほかの端末で録音中なら、参加・参加をやめる・理由を出すのどれか', () => {
        const watching = { ...idle, watchedElsewhere: true, watchedState: 'recording' as const };
        expect(micAction({ ...watching, joinReason: null }).do).toBe('join');
        expect(micAction({ ...watching, joinedHere: true, joinedLabel: '音源 2 として参加中' })).toMatchObject({
            do: 'leave',
            icon: 'leave',
            label: '音源 2 として参加中。クリックして参加をやめる',
        });
        expect(micAction({ ...watching, joinReason: '参加できる音源の数に達しています' })).toMatchObject({
            do: 'notice',
            notice: '参加できる音源の数に達しています',
            hint: '参加できる音源の数に達しています',
            disabled: true,
            showHint: true,
        });
        const unknown = micAction(watching);
        expect(unknown.notice).toBe('ほかの端末で録音中です。操作はその端末でしてください');
        expect(unknown.label).toMatch(/この端末では閲覧専用です$/);
    });
});

describe('describeJoined', () => {
    it('つなぎ直し・返事待ち・参加中を出し分ける', () => {
        expect(describeJoined({ sessionId: 's', source: 2, state: 'reconnecting' })).toBe('ホストにつなぎ直しています');
        expect(describeJoined({ sessionId: 's', source: null, state: 'joined' })).toBe('参加しています…');
        expect(describeJoined({ sessionId: 's', source: 2, state: 'joined' })).toBe('音源 2 として参加中');
    });
});
