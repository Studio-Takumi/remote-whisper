// デモ版（#413）のデータを、ビルド時に画面へ同梱する Vite のプラグイン。
// `virtual:rw-demo-data` で一覧（demoIndex）を、セッションの中身はセッションごとに別のチャンクで（開いたときに）読む。
// データがなければ demoIndex は null（画面は mock.ts のダミーデータで動く）
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

import { type DemoData, readDemoHome } from './demoHome.ts';

const INDEX_ID = 'virtual:rw-demo-data';
// セッションごとのチャンク。名前の最後（demo-session-<番号>）が、出力のファイル名になる
const SESSION_ID = 'virtual:rw-demo-data/demo-session-';

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

// 大きな JSON は、オブジェクトのリテラルより JSON.parse のほうが速く読める
function jsonModule(value: unknown) {
    return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function indexModule(data: DemoData | null) {
    if (!data) {
        return 'export const demoIndex = null;\nexport function loadDemoSession() { return null; }\n';
    }
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
        '',
    ].join('\n');
}

// dir が null ならデータなし（テスト・CI）
export function demoDataPlugin(dir: string | null): Plugin {
    let data: DemoData | null | undefined;
    const read = () => {
        if (data === undefined) {
            data = dir ? readDemoHome(join(dir, 'home')) : null;
        }
        return data;
    };
    return {
        name: 'rw-demo-data',
        resolveId(id) {
            return id === INDEX_ID || id.startsWith(SESSION_ID) ? `\0${id}` : null;
        },
        load(id) {
            if (id === `\0${INDEX_ID}`) {
                return indexModule(read());
            }
            if (id.startsWith(`\0${SESSION_ID}`)) {
                const session = read()?.sessions[Number(id.slice(SESSION_ID.length + 1))];
                return `export default ${jsonModule(session?.data ?? null)};\n`;
            }
            return null;
        },
    };
}
