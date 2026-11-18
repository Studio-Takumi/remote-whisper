// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDemoData } from './demoDataPlugin.ts';

// home/ にプロジェクト 1 つ、replay/ に同じ名前の別のプロジェクト（録音したセッション 1 つと記録）
const SID = '20261111-161646';
let root: string;

function write(path: string, text: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}

function projectJson(uuid: string, path: string, sessions: unknown[]) {
    return JSON.stringify({ version: 1, uuid, path, sessions });
}

const entry = {
    id: SID,
    uuid: 's-replay',
    title: '最終のタイトル',
    status: 'done',
    startedAt: '2026-11-11T16:16:46+09:00',
};

function log(lines: unknown[]) {
    write(join(root, 'replay', 'replay.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rw-demo-replay-'));
    write(join(root, 'home', 'setting.json'), JSON.stringify({ projectOrder: ['home1'] }));
    write(join(root, 'home', 'projects', 'home1', 'project.json'), projectJson('u-home', 'projects/国会', []));
    write(join(root, 'replay', 'project.json'), projectJson('u-replay', 'replay/国会', [entry]));
    write(join(root, 'replay', `transcript-${SID}.md`), `---\nid: ${SID}\n---\n[00:00:01] こんにちは\n`);
    log([
        { t: 0.04, dir: 'out', msg: { type: 'start', project: 'rp1' } },
        { t: 0.05, dir: 'in', msg: { type: 'status', recordings: 1 } },
        { t: 0.06, dir: 'in', msg: { type: 'started', sessionUuid: 's-replay', session: SID } },
        { t: 0.06, dir: 'out', msg: { type: 'audio.begin' } },
        { t: 5, dir: 'in', msg: { type: 'final', segment: 0, start: 1, end: 2, text: 'こんにちは', session: SID } },
        { t: 9, dir: 'out', msg: { type: 'stop' } },
        { t: 12, dir: 'in', msg: { type: 'title', title: '最終のタイトル', provisional: false, session: SID } },
    ]);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('addReplay', () => {
    it('replay/ のプロジェクトを一覧の先頭に足し、サーバーから届いたものだけを記録にする', () => {
        const { data, replay } = readDemoData(root);
        expect(data.index.projects.map((p) => [p.id, p.name])).toEqual([
            ['rp1', '国会'],
            ['home1', '国会'],
        ]);
        expect(data.index.replay).toEqual({ projectId: 'rp1', sessionId: SID });
        expect(data.index.sessions.rp1).toMatchObject([{ id: SID, uuid: 's-replay', status: 'done' }]);
        expect(data.sessions.find((s) => s.projectId === 'rp1')?.data.transcript?.lines).toEqual([
            { time: '00:00:01', text: 'こんにちは' },
        ]);
        expect(replay?.stopAt).toBe(9);
        expect(replay?.messages.map((m) => m.msg.type)).toEqual(['status', 'started', 'final', 'title']);
    });

    it('replay/ がなければ、リプレイなし', () => {
        rmSync(join(root, 'replay'), { recursive: true });
        const { data, replay } = readDemoData(root);
        expect(replay).toBeNull();
        expect(data.index.replay).toBeUndefined();
        expect(data.index.projects.map((p) => p.id)).toEqual(['home1']);
    });

    it('記録に start・stop がない、home/ と ID が重なるときは、ビルドを止める', () => {
        log([{ t: 0, dir: 'in', msg: { type: 'started', session: SID } }]);
        expect(() => readDemoData(root)).toThrow('start・started・stop がありません');
        log([
            { t: 0, dir: 'out', msg: { type: 'start', project: 'home1' } },
            { t: 0, dir: 'in', msg: { type: 'started', session: SID } },
            { t: 1, dir: 'out', msg: { type: 'stop' } },
        ]);
        expect(() => readDemoData(root)).toThrow('home/ にもあります');
    });
});
