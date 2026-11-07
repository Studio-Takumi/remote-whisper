// クラウド版の画面のヘッダー（web/public/_headers。#166）の CSP に書いたハッシュが、index.html の
// インラインのスクリプトと合っているか。index.html を直してハッシュを替え忘れると、CSP を強制にした日に
// テーマの設定が黙って止まるので、ここで気づく
import { describe, expect, it } from 'vitest';

import html from '../index.html?raw';
import headers from '../public/_headers?raw';

async function hash(s: string) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    return `sha256-${btoa(String.fromCharCode(...digest))}`;
}

describe('_headers の CSP', () => {
    it('index.html のインラインのスクリプトのハッシュ（LF・CRLF）が入っている', async () => {
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        expect(scripts).toHaveLength(1);
        const lf = scripts[0].replace(/\r\n/g, '\n');
        const crlf = lf.replace(/\n/g, '\r\n');
        expect(headers).toContain(`'${await hash(lf)}'`);
        expect(headers).toContain(`'${await hash(crlf)}'`);
    });

    // #253: 強制にし、iframe に入れさせず、違反を /csp-report に送らせる
    it('強制で、frame-ancestors と報告の送り先がある', () => {
        const line = headers.split(/\r?\n/).find((l) => /^\s+Content-Security-Policy:/.test(l));
        expect(line).toBeDefined();
        expect(line).toContain("frame-ancestors 'none'");
        expect(line).toContain('report-uri /csp-report');
        // report-to を付けると Chromium は report-uri を使わなくなる（_headers の説明）
        expect(line).not.toContain('report-to');
    });
});
