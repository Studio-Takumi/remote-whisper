import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UNKNOWN, appVersion } from './app-version.mjs';

// server/tests/test_version.py と同じ 4 通り（タグちょうど・タグより後・dirty・タグなし）を、同じ規則で確かめる
let repo: string;

const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const commit = (name: string) => {
    writeFileSync(join(repo, 'a.txt'), name);
    git('add', 'a.txt');
    git('commit', '-q', '-m', name);
};

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'rw-version-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    commit('first');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const head = () => git('rev-parse', '--short', 'HEAD');

describe('appVersion', () => {
    it('is the short hash when there is no tag', () => {
        expect(appVersion(repo)).toBe(head());
    });

    it('marks uncommitted changes with +dirty when there is no tag', () => {
        writeFileSync(join(repo, 'a.txt'), 'changed');
        expect(appVersion(repo)).toBe(`${head()}+dirty`);
    });

    it('is the tag exactly on a tagged commit', () => {
        git('tag', 'v1.0.0');
        expect(appVersion(repo)).toBe('v1.0.0');
    });

    it('adds the hash after the tag when ahead of it', () => {
        git('tag', 'v1.0.0');
        commit('second');
        expect(appVersion(repo)).toBe(`v1.0.0+${head()}`);
    });

    it('adds .dirty to the hash after the tag', () => {
        git('tag', 'v1.0.0');
        writeFileSync(join(repo, 'a.txt'), 'changed');
        expect(appVersion(repo)).toBe(`v1.0.0+${head()}.dirty`);
    });

    it('ignores untracked files', () => {
        git('tag', 'v1.0.0');
        writeFileSync(join(repo, 'new.txt'), 'x');
        expect(appVersion(repo)).toBe('v1.0.0');
    });

    it('skips rc tags', () => {
        git('tag', 'v1.0.0');
        commit('second');
        git('tag', 'v1.1.0-rc1');
        expect(appVersion(repo)).toBe(`v1.0.0+${head()}`);
    });

    it('falls back to the hash when only rc tags exist', () => {
        git('tag', 'v1.0.0-rc1');
        expect(appVersion(repo)).toBe(head());
    });

    it('is unknown outside a git repository', () => {
        expect(appVersion(join(repo, 'missing'))).toBe(UNKNOWN);
    });
});
