// デモ版（#413）に同梱するデータを、~/.remote-whisper と同じ構成の home/ から作る。
// 返す JSON はサーバーの API（routes/projects.py・routes/sessions/read.py）と同じもの。
// ちがうのは、録音は同梱しないので files.recording をいつも false にすることだけ
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { DemoIndex, DemoJson, DemoSession, DemoSummaryInfo } from '../src/api/demoTypes.ts';
import { parseDoc, parseTranscriptLines } from './demoDocs.ts';

export type DemoData = { index: DemoIndex; sessions: { projectId: string; sessionId: string; data: DemoSession }[] };

const ID = String.raw`\d{8}-\d{6}`;
const SUMMARY_RE = new RegExp(`^summary-(${ID})-(${ID})\\.md$`);
const FINAL_TRANSCRIPT_RE = new RegExp(`^transcript-final-(${ID})-(${ID})\\.md$`);
const ID_RE = new RegExp(`^${ID}$`);
const PID_RE = /^[A-Za-z0-9-]+$/;

const DEFAULT_MODEL = 'gemma4:e4b';

function readJson(path: string): DemoJson {
    return JSON.parse(readFileSync(path, 'utf8')) as DemoJson;
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

// フロントマターに要る項目がそろっているか（サーバーは pydantic で確かめ、合わないファイルは飛ばす）
function hasFields(meta: DemoJson, fields: Record<string, 'string' | 'boolean'>) {
    return Object.entries(fields).every(([key, type]) => typeof meta[key] === type);
}

// UI に出す名前（ディレクトリ名）。ドライブのルートならパスそのもの（storage/projects.py の display_name）
export function displayName(path: string) {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

// project.json の並び（setting.json の projectOrder）。ないものは先頭（storage/projects.py の order_projects）
function orderProjects<T extends { id: string }>(items: T[], order: string[]): T[] {
    const rank = new Map(order.map((id, i) => [id, i]));
    const unlisted = items.filter((p) => !rank.has(p.id));
    const listed = items.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    return [...unlisted, ...listed];
}

// 生成 ID の昇順に、読めるものだけ（session_reader.py の summaries・final_transcripts）
function generations(dir: string, files: string[], re: RegExp, sid: string) {
    const result: { gid: string; meta: DemoJson; body: string }[] = [];
    for (const name of files.filter((f) => re.exec(f)?.[1] === sid).sort()) {
        try {
            const { meta, body } = parseDoc(readFileSync(join(dir, name), 'utf8'));
            result.push({ gid: re.exec(name)![2], meta, body });
        } catch (e) {
            console.warn(`デモのデータ: ${name} を読めないので飛ばします: ${(e as Error).message}`);
        }
    }
    return result.sort((a, b) => (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0));
}

function summaryInfo(gid: string, meta: DemoJson): DemoSummaryInfo {
    const model = meta.model as string;
    return {
        generationId: gid,
        model,
        overviewModel: str(meta.overviewModel) ?? model,
        think: meta.think as boolean,
        generatedAt: meta.generatedAt as string,
        title: str(meta.title),
    };
}

// 音源が 2 つ以上のときだけの項目は、なければ出さない（documents.py の _drop_empty_sources）
function dropEmptySources(meta: DemoJson): DemoJson {
    const result = { ...meta };
    for (const key of ['sources', 'lineSources']) {
        if (result[key] === null || result[key] === undefined) {
            delete result[key];
        }
    }
    return result;
}

// 文字起こしのフロントマター（TranscriptMeta.to_json）。ないものは既定値
function transcriptMeta(meta: DemoJson): DemoJson {
    return dropEmptySources({
        project: null,
        uuid: null,
        title: null,
        endedAt: null,
        durationSec: null,
        language: 'ja',
        whisper: null,
        contextSet: null,
        useHotwords: false,
        recording: null,
        summaryFailed: false,
        appVersion: null,
        pickedTerms: [],
        rejectedTerms: [],
        manualTerms: [],
        corrections: [],
        source: null,
        originalName: null,
        uploadedAt: null,
        materialRange: null,
        baseContextSet: null,
        sources: null,
        lineSources: null,
        ...meta,
    });
}

// 最終の文字起こしのフロントマター（FinalTranscriptMeta.to_json）。ID はファイル名を正とする
function finalTranscriptMeta(sid: string, gid: string, meta: DemoJson) {
    return {
        ...dropEmptySources({
            project: null,
            recording: null,
            alignModel: null,
            diarization: 'off',
            speakers: 0,
            appVersion: null,
            sources: null,
            lineSources: null,
            ...meta,
        }),
        id: sid,
        generationId: gid,
    };
}

function readSession(dir: string, files: string[], sid: string) {
    const transcriptPath = join(dir, `transcript-${sid}.md`);
    let transcript: DemoSession['transcript'];
    if (existsSync(transcriptPath)) {
        const { meta, body } = parseDoc(readFileSync(transcriptPath, 'utf8'));
        transcript = { meta: transcriptMeta(meta), lines: parseTranscriptLines(body) };
    }
    // 置き換え（#176）は、サーバーでは最終の文字起こしに読むときに当てる。デモではその処理を持たないので、ないものだけ載せる
    const corrections = transcript?.meta.corrections;
    if (Array.isArray(corrections) && corrections.length > 0) {
        throw new Error(
            `デモのデータ: ${transcriptPath} に置き換え（corrections）があります。デモ版は対応していません`,
        );
    }

    const finals = generations(dir, files, FINAL_TRANSCRIPT_RE, sid).filter(({ meta }) =>
        hasFields(meta, { model: 'string', generatedAt: 'string' }),
    );
    const summaries = generations(dir, files, SUMMARY_RE, sid).filter(({ meta }) =>
        hasFields(meta, { startedAt: 'string', model: 'string', think: 'boolean', generatedAt: 'string' }),
    );
    const livePath = join(dir, '.tmp', sid, 'live-summary.md');
    const data: DemoSession = {
        transcript,
        finalTranscripts: finals.map(({ gid, meta }) => finalTranscriptMeta(sid, gid, meta)),
        finalTranscriptLines: Object.fromEntries(finals.map(({ gid, body }) => [gid, parseTranscriptLines(body)])),
        summaries: summaries.map(({ gid, meta }) => summaryInfo(gid, meta)),
        summaryTexts: Object.fromEntries(summaries.map(({ gid, body }) => [gid, body])),
        liveSummary: existsSync(livePath) ? readFileSync(livePath, 'utf8') : undefined,
    };
    // どのファイルが残っているか（session_reader.py の availability）。録音は同梱しない
    const available = {
        recording: false,
        transcript: transcript !== undefined,
        finalTranscripts: finals.length,
        summaries: summaries.length,
        liveSummary: data.liveSummary !== undefined,
    };
    return { data, available };
}

// セッションの行（SessionEntry の model_dump と files）
function sessionRow(entry: DemoJson, files: DemoJson): DemoJson & { id: string } {
    return {
        id: entry.id as string,
        uuid: str(entry.uuid),
        title: str(entry.title),
        status: entry.status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt ?? null,
        durationSec: entry.durationSec ?? null,
        contextSet: entry.contextSet ?? null,
        summaryFailed: entry.summaryFailed ?? false,
        source: entry.source ?? null,
        uploadedAt: entry.uploadedAt ?? null,
        files,
    };
}

// selection がまだなければ、ready のセットのうち最初に作ったものを選ぶ（ProjectFile.effective_selection）
function selection(project: DemoJson) {
    const saved = project.selection as DemoJson | null | undefined;
    const sets = (project.contextSets ?? []) as DemoJson[];
    const ready = sets
        .filter((s) => s.status === 'ready' && !s.session)
        .map((s) => s.id as string)
        .sort();
    return {
        contextSet: saved ? (saved.contextSet ?? null) : (ready[0] ?? null),
        useHotwords: saved?.useHotwords ?? true,
        useContext: saved?.useContext ?? true,
        pickTerms: saved?.pickTerms ?? true,
    };
}

// home/ を読む。project.json のないディレクトリは飛ばす（サーバーも一覧に出さない）
export function readDemoHome(home: string): DemoData {
    const settingPath = join(home, 'setting.json');
    const setting = existsSync(settingPath) ? readJson(settingPath) : {};
    const ollama = ((setting.ollama as DemoJson | undefined)?.models ?? {}) as DemoJson;
    const root = join(home, 'projects');
    const pids = existsSync(root)
        ? readdirSync(root)
              .filter((name) => PID_RE.test(name) && statSync(join(root, name)).isDirectory())
              .filter((name) => existsSync(join(root, name, 'project.json')))
              .sort()
        : [];

    const index: DemoIndex = {
        projects: [],
        sessions: {},
        contextSets: {},
        models: { overview: str(ollama.overview) ?? DEFAULT_MODEL, detail: str(ollama.detail) ?? DEFAULT_MODEL },
    };
    const sessions: DemoData['sessions'] = [];
    const projects = pids.map((pid) => ({ id: pid, project: readJson(join(root, pid, 'project.json')) }));
    for (const { id: pid, project } of orderProjects(projects, (setting.projectOrder ?? []) as string[])) {
        const path = project.path as string;
        if (typeof project.uuid !== 'string') {
            throw new Error(`デモのデータ: ${pid} の project.json に uuid がありません`);
        }
        index.projects.push({
            id: pid,
            uuid: project.uuid,
            name: displayName(path),
            path,
            selection: selection(project),
            summaryDir: project.summaryDir ?? '',
        });
        index.contextSets[pid] = ((project.contextSets ?? []) as DemoJson[])
            .filter((s) => !s.session)
            .map((s) => ({ id: s.id, status: s.status, materials: s.materials ?? [] }));
        const dir = join(root, pid);
        const files = readdirSync(dir);
        const entries = ((project.sessions ?? []) as DemoJson[]).filter((s) => ID_RE.test(String(s.id)));
        index.sessions[pid] = [...entries].reverse().map((entry) => {
            const sid = entry.id as string;
            if (typeof entry.uuid !== 'string') {
                throw new Error(`デモのデータ: ${pid} のセッション ${sid} に uuid がありません`);
            }
            const { data, available } = readSession(dir, files, sid);
            sessions.push({ projectId: pid, sessionId: sid, data });
            return sessionRow(entry, available);
        });
    }
    return { index, sessions };
}
