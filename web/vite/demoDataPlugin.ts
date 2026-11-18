// デモ版（#413）のデータを、ビルド時に画面へ同梱する Vite のプラグイン。
// `virtual:rw-demo-data` で一覧（demoIndex）を、セッションの中身はセッションごとに別のチャンクで（開いたときに）読む。
// リプレイ（#416）の記録も別のチャンクで、開いたときに読む。
// データがなければ demoIndex は null（画面は mock.ts のダミーデータで動く）
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

import type { DemoReplay } from '../src/api/demoTypes.ts';
import { type DemoData, readDemoHome } from './demoHome.ts';
import { addReplay } from './demoReplay.ts';

const INDEX_ID = 'virtual:rw-demo-data';
// セッションごとのチャンク。名前の最後（demo-session-<番号>）が、出力のファイル名になる
const SESSION_ID = 'virtual:rw-demo-data/demo-session-';
// リプレイの記録のチャンク
const REPLAY_ID = 'virtual:rw-demo-data/demo-replay';

type Bundle = { data: DemoData; replay: DemoReplay | null };

// データの置き場（中は home/・replay/）。RW_DEMO_DATA（相対パスは今のディレクトリから）、なければ
// リポジトリの隣の rw-hp-contents/demo。RW_DEMO_DATA を渡したのに home/ がなければ、ビルドを止める
export function demoDataDir(webDir: string, env: string | undefined = process.env.RW_DEMO_DATA): string | null {
    const dir = env ? resolve(env) : resolve(webDir, '..', '..', 'rw-hp-contents', 'demo');
    if (existsSync(join(dir, 'home'))) {
        return dir;
    }
    if (env) {
        throw new Error(`RW_DEMO_DATA（${dir}）に home/ がありません`);
    }
    return null;
}

// home/ と replay/ を読む
export function readDemoData(dir: string): Bundle {
    const data = readDemoHome(join(dir, 'home'));
    const replay = addReplay(data, join(dir, 'replay'));
    return { data, replay };
}

// 大きな JSON は、オブジェクトのリテラルより JSON.parse のほうが速く読める
function jsonModule(value: unknown) {
    return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function indexModule(bundle: Bundle | null) {
    if (!bundle) {
        return [
            'export const demoIndex = null;',
            'export function loadDemoSession() { return null; }',
            'export function loadDemoReplay() { return null; }',
            '',
        ].join('\n');
    }
    const { data, replay } = bundle;
    const loaders = data.sessions
        .map(
            (s, i) =>
                `${JSON.stringify(`${s.projectId}/${s.sessionId}`)}: () => import(${JSON.stringify(SESSION_ID + i)})`,
        )
        .join(',\n');
    return [
        `export const demoIndex = ${jsonModule(data.index)};`,
        `const loaders = {\n${loaders}\n};`,
        'export function loadDemoSession(projectId, sessionId) {',
        '    const load = loaders[`${projectId}/${sessionId}`];',
        '    return load ? load().then((m) => m.default) : null;',
        '}',
        replay
            ? `export function loadDemoReplay() { return import(${JSON.stringify(REPLAY_ID)}).then((m) => m.default); }`
            : 'export function loadDemoReplay() { return null; }',
        '',
    ].join('\n');
}

// dir が null ならデータなし（テスト・CI）
export function demoDataPlugin(dir: string | null): Plugin {
    let bundle: Bundle | null | undefined;
    const read = () => {
        if (bundle === undefined) {
            bundle = dir ? readDemoData(dir) : null;
        }
        return bundle;
    };
    return {
        name: 'rw-demo-data',
        resolveId(id) {
            return id === INDEX_ID || id === REPLAY_ID || id.startsWith(SESSION_ID) ? `\0${id}` : null;
        },
        load(id) {
            if (id === `\0${INDEX_ID}`) {
                return indexModule(read());
            }
            if (id === `\0${REPLAY_ID}`) {
                return `export default ${jsonModule(read()?.replay ?? null)};\n`;
            }
            if (id.startsWith(`\0${SESSION_ID}`)) {
                const session = read()?.data.sessions[Number(id.slice(SESSION_ID.length + 1))];
                return `export default ${jsonModule(session?.data ?? null)};\n`;
            }
            return null;
        },
    };
}
