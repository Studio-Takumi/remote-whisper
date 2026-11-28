import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Markdown } from '@/components/Markdown';
import { LineText } from '@/features/session/LineText';

// ユーザーの言葉を出す部品に、中身の言語で lang が付くか（#497）
describe('部品の lang', () => {
    afterEach(cleanup);

    it('文字起こしの行: 日本語なら ja、英語だけなら付けない', () => {
        const { container } = render(<LineText text='今日はリリース計画について' />);
        expect(container.querySelector('[data-correctable]')?.getAttribute('lang')).toBe('ja');
        cleanup();
        const en = render(<LineText text='Release plan for today' />);
        expect(en.container.querySelector('[data-correctable]')?.hasAttribute('lang')).toBe(false);
    });

    it('話者の札のある行: 札（UI の文）ではなく本文に付ける', () => {
        const { container } = render(<LineText text='話者 1: 今日は' />);
        expect(container.querySelector('[data-correctable]')?.getAttribute('lang')).toBe('ja');
    });

    it('要約: 日本語なら ja、英語だけなら付けない', () => {
        const ja = render(<Markdown>{'## 要点\n- 二分探索'}</Markdown>);
        expect((ja.container.firstElementChild as HTMLElement).getAttribute('lang')).toBe('ja');
        cleanup();
        const en = render(<Markdown>{'## Key points\n- Binary search'}</Markdown>);
        expect((en.container.firstElementChild as HTMLElement).hasAttribute('lang')).toBe(false);
    });
});
