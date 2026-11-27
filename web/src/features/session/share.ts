import type { TranscriptLine } from '@/api/types';
import { copyText } from '@/components/copyMarkdown';
import { sessionMessages } from '@/features/session/i18n';

// 文字起こし・要約を OS の共有機能（Web Share API）で他のアプリに渡す（#335）

export type ShareWhat = 'summary' | 'transcript' | 'both';

export type ShareSource = {
    title: string;
    summary?: string;
    transcript: TranscriptLine[];
};

// これより長いときは、テキストではなく .md のファイルにして渡す。
// 受け取るアプリ（ChatGPT など）によっては、長いテキストが途中で切れたり、貼り付け欄に入りきらなかったりするため
export const SHARE_TEXT_LIMIT = 8000;

const SHARE_LABEL_KEYS = {
    summary: 'share.summary',
    transcript: 'share.transcript',
    both: 'share.both',
} as const;

export function shareLabel(what: ShareWhat): string {
    return sessionMessages.t(SHARE_LABEL_KEYS[what]);
}

// 渡せる内容があるか（要約がまだない・文字起こしが空のときは選べない）
export function canShareWhat(source: ShareSource, what: ShareWhat) {
    const hasSummary = !!source.summary?.trim();
    const hasTranscript = source.transcript.length > 0;
    return what === 'summary' ? hasSummary : what === 'transcript' ? hasTranscript : hasSummary && hasTranscript;
}

export function transcriptText(lines: TranscriptLine[]) {
    return lines.map((l) => `[${l.time}] ${l.text}`).join('\n');
}

// 渡す本文（Markdown）。追加の指示があれば先頭に付ける
export function buildShareText(source: ShareSource, what: ShareWhat, instruction: string) {
    const parts: string[] = [];
    if (instruction.trim()) parts.push(instruction.trim());
    parts.push(`# ${source.title}`);
    if (what !== 'transcript')
        parts.push(`## ${sessionMessages.t('share.summaryHeading')}\n\n${(source.summary ?? '').trim()}`);
    if (what !== 'summary')
        parts.push(`## ${sessionMessages.t('share.transcriptHeading')}\n\n${transcriptText(source.transcript)}`);
    return `${parts.join('\n\n')}\n`;
}

// ファイル名に使えない文字を除く
export function shareFileName(title: string, ext = 'md') {
    const name = title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 60);
    return `${name || 'remote-whisper'}.${ext}`;
}

// Web Share API が使えるか。https か localhost でしか使えない（LAN の http で開いていると使えない）
export function canUseShare() {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export type ShareResult = 'shared' | 'cancelled';

// 共有シートを出す。短ければテキスト、長ければ .md ファイル（ファイルを渡せない環境ではテキスト）
// シートを閉じたとき（AbortError）は 'cancelled'。それ以外の失敗は投げる
export async function shareContent(source: ShareSource, what: ShareWhat, instruction: string): Promise<ShareResult> {
    const text = buildShareText(source, what, instruction);
    const data: ShareData = { title: source.title };
    if (text.length > SHARE_TEXT_LIMIT) {
        // Chrome は .md・text/markdown を共有に渡せないので、共有に渡すファイルは .txt にする（中身は Markdown のまま）
        const file = new File([text], shareFileName(source.title, 'txt'), { type: 'text/plain' });
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            data.files = [file];
        } else {
            data.text = text;
        }
    } else {
        data.text = text;
    }
    try {
        await navigator.share(data);
        return 'shared';
    } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
        throw e;
    }
}

export function copyShareText(source: ShareSource, what: ShareWhat, instruction: string) {
    return copyText(buildShareText(source, what, instruction));
}

// .md のファイルとして保存する
export function downloadShareText(source: ShareSource, what: ShareWhat, instruction: string) {
    const blob = new Blob([buildShareText(source, what, instruction)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = shareFileName(source.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Safari（iOS・PWA）は click の直後に解放すると保存できないことがあるので、少し待つ
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
