// デモ版のリプレイ（#416）のデータを、replay/ から読む。replay/ はプロジェクトのディレクトリと同じ構成
// （project.json と md）に、録音したときの WebSocket のやりとり（replay.jsonl）を足したもの
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DemoJson, DemoReplay } from '../src/api/demoTypes.ts';
import { type DemoData, addProject } from './demoHome.ts';

type Line = { t: number; dir: 'in' | 'out'; msg: DemoJson };

function readLines(path: string): Line[] {
    return readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Line);
}

// replay/ があれば、そのプロジェクトを一覧の先頭に足し（projectOrder にないプロジェクトは先頭。サーバーと同じ）、
// 記録を返す。なければ null
export function addReplay(data: DemoData, dir: string): DemoReplay | null {
    const log = join(dir, 'replay.jsonl');
    if (!existsSync(join(dir, 'project.json')) || !existsSync(log)) {
        return null;
    }
    const lines = readLines(log);
    const start = lines.find((l) => l.dir === 'out' && l.msg.type === 'start');
    const started = lines.find((l) => l.dir === 'in' && l.msg.type === 'started');
    const stop = lines.find((l) => l.dir === 'out' && l.msg.type === 'stop');
    const pid = start?.msg.project;
    const sid = started?.msg.session;
    if (typeof pid !== 'string' || typeof sid !== 'string' || !stop) {
        throw new Error(`デモのデータ: ${log} に start・started・stop がありません`);
    }
    if (data.index.sessions[pid]) {
        throw new Error(`デモのデータ: リプレイのプロジェクト ${pid} が home/ にもあります`);
    }
    const replay: DemoData = { index: { ...data.index, projects: [], sessions: {}, contextSets: {} }, sessions: [] };
    addProject(replay, pid, dir);
    if (!replay.index.sessions[pid].some((row) => row.id === sid)) {
        throw new Error(`デモのデータ: リプレイのセッション ${sid} が ${dir} の project.json にありません`);
    }
    data.index.projects.unshift(...replay.index.projects);
    Object.assign(data.index.sessions, replay.index.sessions);
    Object.assign(data.index.contextSets, replay.index.contextSets);
    data.sessions.push(...replay.sessions);
    data.index.replay = { projectId: pid, sessionId: sid };
    const messages = lines
        .filter((l) => l.dir === 'in')
        .map(({ t, msg }) => ({ t, msg }))
        .sort((a, b) => a.t - b.t);
    return { messages, stopAt: stop.t };
}
