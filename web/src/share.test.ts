import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    SHARE_TEXT_LIMIT,
    type ShareSource,
    buildShareText,
    canShareWhat,
    canUseShare,
    shareContent,
    shareFileName,
} from '@/share';

const source: ShareSource = {
    title: '第3回 講義',
    summary: '## 概要\n\nまとめ',
    transcript: [
        { time: '00:00:01', text: 'はじめます' },
        { time: '00:00:05', text: '次です' },
    ],
};

afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
});

function mockShare(share: unknown, canShare?: unknown) {
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true });
}

describe('buildShareText', () => {
    it('要約だけ', () => {
        expect(buildShareText(source, 'summary', '')).toBe('# 第3回 講義\n\n## 要約\n\n## 概要\n\nまとめ\n');
    });
    it('文字起こしだけ（時刻つき）', () => {
        expect(buildShareText(source, 'transcript', '')).toBe(
            '# 第3回 講義\n\n## 文字起こし\n\n[00:00:01] はじめます\n[00:00:05] 次です\n',
        );
    });
    it('両方と、追加の指示が先頭に付く', () => {
        const text = buildShareText(source, 'both', '  試験に出そうなところを整理して ');
        expect(text.startsWith('試験に出そうなところを整理して\n\n# 第3回 講義')).toBe(true);
        expect(text).toContain('## 要約');
        expect(text).toContain('## 文字起こし');
    });
});

describe('canShareWhat', () => {
    it('要約がなければ要約と両方は選べない', () => {
        const none = { ...source, summary: undefined };
        expect(canShareWhat(none, 'summary')).toBe(false);
        expect(canShareWhat(none, 'both')).toBe(false);
        expect(canShareWhat(none, 'transcript')).toBe(true);
    });
    it('文字起こしが空なら全文は選べない', () => {
        expect(canShareWhat({ ...source, transcript: [] }, 'transcript')).toBe(false);
    });
});

describe('shareFileName', () => {
    it('使えない文字を除き、空なら既定の名前', () => {
        expect(shareFileName('a/b:c')).toBe('abc.md');
        expect(shareFileName('///')).toBe('remote-whisper.md');
    });
});

describe('shareContent', () => {
    it('navigator.share が無ければ使えない', () => {
        expect(canUseShare()).toBe(false);
    });
    it('短いときはテキストで渡す', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        mockShare(share, vi.fn());
        expect(await shareContent(source, 'summary', '')).toBe('shared');
        const data = share.mock.calls[0][0];
        expect(data.text).toContain('まとめ');
        expect(data.files).toBeUndefined();
    });
    it('長いときは .md のファイルで渡す', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        mockShare(share, vi.fn().mockReturnValue(true));
        const long = { ...source, transcript: [{ time: '00:00:01', text: 'あ'.repeat(SHARE_TEXT_LIMIT) }] };
        await shareContent(long, 'transcript', '');
        const data = share.mock.calls[0][0];
        expect(data.text).toBeUndefined();
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('第3回 講義.md');
    });
    it('長くてもファイルを渡せない環境ではテキストで渡す', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        mockShare(share, vi.fn().mockReturnValue(false));
        const long = { ...source, transcript: [{ time: '00:00:01', text: 'あ'.repeat(SHARE_TEXT_LIMIT) }] };
        await shareContent(long, 'transcript', '');
        expect(share.mock.calls[0][0].text).toBeDefined();
    });
    it('共有シートを閉じたとき（AbortError）はエラーにしない', async () => {
        mockShare(vi.fn().mockRejectedValue(new DOMException('x', 'AbortError')));
        expect(await shareContent(source, 'summary', '')).toBe('cancelled');
    });
    it('ほかの失敗は投げる', async () => {
        mockShare(vi.fn().mockRejectedValue(new DOMException('x', 'NotAllowedError')));
        await expect(shareContent(source, 'summary', '')).rejects.toThrow();
    });
});
