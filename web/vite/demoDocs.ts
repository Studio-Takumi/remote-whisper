// デモ版（#413）のデータの md を、サーバーと同じ結果になるように読む。
// サーバーの storage/documents.py の parse と、storage/session_reader.py の parse_transcript_lines を写したもの
import { parse as parseYaml } from 'yaml';

import type { DemoJson, DemoLine } from '../src/api/demoTypes.ts';

// Python の str.splitlines が行の区切りとみなす文字（制御文字も区切りなので、わざと入れる）
// oxlint-disable-next-line no-control-regex
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
// Python の str.strip が消す空白（str.isspace）
const SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'g');
// 文字起こしの本文の 1 行。例: [00:00:03] 今日は…（session_reader.py の LINE_RE）
const LINE_RE = new RegExp(`^\\[(\\p{Nd}{2}:\\p{Nd}{2}:\\p{Nd}{2})\\][${SPACE}]?([^\\n]*)$`, 'u');

function pyStrip(text: string) {
    return text.replace(STRIP, '');
}

// keepends=True の splitlines
function splitKeepEnds(text: string): string[] {
    const lines: string[] = [];
    let rest = text;
    while (rest !== '') {
        const m = LINE_BREAK.exec(rest);
        const end = m ? m.index + m[0].length : rest.length;
        lines.push(rest.slice(0, end));
        rest = rest.slice(end);
    }
    return lines;
}

function withoutBreak(line: string) {
    return line.replace(/[\r\n]+$/, '');
}

// YAML はサーバー（PyYAML の SafeLoader）と同じく 1.1 で読み、日時は文字列のまま（documents.py の _Loader）
function loadYaml(text: string): unknown {
    return parseYaml(text, {
        version: '1.1',
        customTags: (tags) => tags.filter((t) => typeof t === 'string' || t.tag !== 'tag:yaml.org,2002:timestamp'),
    });
}

// `---` で囲んだ YAML と本文に分ける。壊れていれば Error
export function parseDoc(text: string): { meta: DemoJson; body: string } {
    // 先頭の BOM（U+FEFF）は外す
    const lines = splitKeepEnds(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (lines.length === 0 || withoutBreak(lines[0]) !== '---') {
        throw new Error('フロントマターがありません');
    }
    for (let i = 1; i < lines.length; i++) {
        if (withoutBreak(lines[i]) === '---') {
            const meta = loadYaml(lines.slice(1, i).join('')) ?? {};
            if (typeof meta !== 'object' || Array.isArray(meta)) {
                throw new Error('フロントマターが辞書ではありません');
            }
            return { meta: meta as DemoJson, body: lines.slice(i + 1).join('') };
        }
    }
    throw new Error('フロントマターが閉じていません');
}

// 本文を `{time, text}` の行に分ける。形式に合わない行は、前の行の続きとして扱う
export function parseTranscriptLines(body: string): DemoLine[] {
    const lines: DemoLine[] = [];
    for (const raw of body.split(LINE_BREAK)) {
        const line = pyStrip(raw);
        if (!line) {
            continue;
        }
        const m = LINE_RE.exec(line);
        if (m) {
            lines.push({ time: m[1], text: m[2] });
        } else if (lines.length > 0) {
            lines[lines.length - 1].text += '\n' + line;
        } else {
            lines.push({ time: '', text: line });
        }
    }
    return lines;
}
