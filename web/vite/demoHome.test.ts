// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { demoDataDir } from './demoDataPlugin.ts';
import { parseDoc, parseTranscriptLines } from './demoDocs.ts';
import { readDemoHome } from './demoHome.ts';

// 小さな偽のデータ（チャンネル 2 つ。片方にセッション 1 つ、浄書 1 つ、要約 2 つ）
const SID = '20260101-100000';
let root: string;

function write(path: string, text: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}

function project(pid: string, path: string, sessions: unknown[]) {
    write(
        join(root, 'home', 'projects', pid, 'project.json'),
        JSON.stringify({ version: 1, uuid: `u-${pid}`, path, sessions }),
    );
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rw-demo-'));
    write(
        join(root, 'home', 'setting.json'),
        JSON.stringify({
            ollama: { models: { overview: 'gemma4:e4b', detail: 'gemma4:e4b' } },
            projectOrder: ['b', 'a'],
        }),
    );
    project('a', 'C:\\bench\\Channel A', [
        {
            id: SID,
            uuid: 's-1',
            title: '動画 1',
            status: 'done',
            startedAt: '2026-01-01T10:00:00+09:00',
            source: 'upload',
        },
    ]);
    project('b', '/bench/Channel B', []);
    const dir = join(root, 'home', 'projects', 'a');
    write(
        join(dir, `transcript-${SID}.md`),
        `---\nid: ${SID}\nstatus: done\nstartedAt: '2026-01-01T10:00:00+09:00'\n---\n`,
    );
    write(
        join(dir, `transcript-final-${SID}-20260101-110000.md`),
        `---\nid: ${SID}\ngenerationId: 20260101-110000\nmodel: large-v3-turbo\ngeneratedAt: '2026-01-01T11:00:00+09:00'\ndiarization: done\nspeakers: 2\n---\n[00:00:01] 話者 1: こんにちは\n続きの行\n\n[00:00:05] 話者 2: どうも\n`,
    );
    // overviewModel が空のものは、サーバーと同じく model とみなす
    for (const [gid, model] of [
        ['20260101-120000', 'qwen3.5:4b'],
        ['20260101-130000', 'gemma4:e4b'],
    ]) {
        write(
            join(dir, `summary-${SID}-${gid}.md`),
            `---\nid: ${SID}\ngenerationId: ${gid}\ntitle: 'タイトル: ${model}'\nstartedAt: '2026-01-01T10:00:00+09:00'\nmodel: ${model}\noverviewModel: ''\nthink: true\ngeneratedAt: '2026-01-01T12:00:00+09:00'\n---\nこの要約は〜から生成されています。\n\n## 全体概要\n- ${model}\n`,
        );
    }
    // 読めない要約は飛ばす（サーバーと同じ）
    write(join(dir, `summary-${SID}-20260101-140000.md`), 'フロントマターなし\n');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('readDemoHome', () => {
    it('プロジェクトは projectOrder の順で、名前はパスの最後', () => {
        const { index } = readDemoHome(join(root, 'home'));
        expect(index.projects.map((p) => [p.id, p.name])).toEqual([
            ['b', 'Channel B'],
            ['a', 'Channel A'],
        ]);
        expect(index.models).toEqual({ overview: 'gemma4:e4b', detail: 'gemma4:e4b' });
    });

    it('セッションの行は API と同じ形で、録音はないものとする', () => {
        const { index } = readDemoHome(join(root, 'home'));
        expect(index.sessions.a).toEqual([
            {
                id: SID,
                uuid: 's-1',
                title: '動画 1',
                status: 'done',
                startedAt: '2026-01-01T10:00:00+09:00',
                endedAt: null,
                durationSec: null,
                contextSet: null,
                summaryFailed: false,
                source: 'upload',
                uploadedAt: null,
                files: { recording: false, transcript: true, finalTranscripts: 1, summaries: 2, liveSummary: false },
            },
        ]);
        expect(index.sessions.b).toEqual([]);
    });

    it('浄書と要約の版を、古いものから読む', () => {
        const [{ data }] = readDemoHome(join(root, 'home')).sessions;
        expect(data.transcript?.lines).toEqual([]);
        expect(data.finalTranscripts).toMatchObject([
            { generationId: '20260101-110000', diarization: 'done', speakers: 2 },
        ]);
        expect(data.finalTranscriptLines['20260101-110000']).toEqual([
            { time: '00:00:01', text: '話者 1: こんにちは\n続きの行' },
            { time: '00:00:05', text: '話者 2: どうも' },
        ]);
        expect(data.summaries.map((s) => [s.generationId, s.model, s.overviewModel, s.title])).toEqual([
            ['20260101-120000', 'qwen3.5:4b', 'qwen3.5:4b', 'タイトル: qwen3.5:4b'],
            ['20260101-130000', 'gemma4:e4b', 'gemma4:e4b', 'タイトル: gemma4:e4b'],
        ]);
        expect(data.summaryTexts['20260101-130000']).toBe(
            'この要約は〜から生成されています。\n\n## 全体概要\n- gemma4:e4b\n',
        );
    });
});

describe('parseDoc', () => {
    it('日時は文字列のまま、BOM と CRLF も読める', () => {
        const { meta, body } = parseDoc('\uFEFF---\r\ngeneratedAt: 2026-01-01T10:00:00+09:00\r\n---\r\n本文\r\n');
        expect(meta).toEqual({ generatedAt: '2026-01-01T10:00:00+09:00' });
        expect(body).toBe('本文\r\n');
    });

    it('フロントマターがなければエラー', () => {
        expect(() => parseDoc('本文だけ')).toThrow('フロントマターがありません');
    });
});

describe('parseTranscriptLines', () => {
    it('時刻のない最初の行は時刻なしで、空行は飛ばす', () => {
        expect(parseTranscriptLines('前置き\n\n[00:01:02]本文\n')).toEqual([
            { time: '', text: '前置き' },
            { time: '00:01:02', text: '本文' },
        ]);
    });
});

describe('demoDataDir', () => {
    it('RW_DEMO_DATA の home/ があればその場所、なければビルドを止める', () => {
        expect(demoDataDir('/', root)).toBe(root);
        expect(() => demoDataDir('/', join(root, 'none'))).toThrow('home/ がありません');
    });

    it('RW_DEMO_DATA がなく、隣にもデータがなければ null', () => {
        expect(demoDataDir(join(root, 'web'), undefined)).toBeNull();
    });
});
