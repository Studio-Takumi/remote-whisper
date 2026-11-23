// バージョンの文字列を git から作る。サーバー（server/src/remote_whisper/version.py）と同じ規則（spec/api.md 7.1）。
//   タグちょうど            v1.0.0
//   タグより進んでいる      v1.0.0+34a7607
//   未コミットの変更がある  v1.0.0+34a7607.dirty
//   タグが取れない          34a7607（変更があれば 34a7607+dirty）。git がなければ unknown
// -rc などのハイフンを含むタグは拾わない。
// vite.config.ts が読むほか、`node scripts/app-version.mjs` で配布物のビルド（packaging/）も同じ文字列を取る
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UNKNOWN = 'unknown';

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

/** 直近のリリースのタグと、そこからのコミット数。タグが取れなければ null */
function releaseTag(cwd) {
    try {
        const long = git(cwd, ['describe', '--tags', '--long', '--match', 'v[0-9]*', '--exclude', '*-*']);
        const m = /^(.+)-(\d+)-g[0-9a-f]+$/.exec(long);
        return m ? { tag: m[1], ahead: Number(m[2]) } : null;
    } catch {
        return null;
    }
}

/** @param {string} [cwd] */
export function appVersion(cwd = process.cwd()) {
    let commit;
    let dirty;
    try {
        commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
        dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '';
    } catch {
        return UNKNOWN;
    }
    if (!commit) return UNKNOWN;
    const release = releaseTag(cwd);
    if (!release) return dirty ? `${commit}+dirty` : commit;
    if (release.ahead === 0 && !dirty) return release.tag;
    return `${release.tag}+${commit}${dirty ? '.dirty' : ''}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.stdout.write(`${appVersion()}\n`);
}
