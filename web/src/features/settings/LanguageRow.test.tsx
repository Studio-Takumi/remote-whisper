import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LanguageRow } from '@/features/settings/LanguageRow';
import { LANGUAGE_KEY, getLanguage, setLanguage } from '@/i18n/language';

describe('LanguageRow', () => {
    // Radix の Select は開いたときに選んでいるものへ送るが、jsdom には scrollIntoView がない
    const scrollIntoView = Element.prototype.scrollIntoView;
    beforeAll(() => {
        Element.prototype.scrollIntoView = () => {};
    });
    afterAll(() => {
        Element.prototype.scrollIntoView = scrollIntoView;
    });
    afterEach(() => {
        cleanup();
        act(() => setLanguage('ja'));
        localStorage.removeItem(LANGUAGE_KEY);
    });

    it('English を選ぶと、表示言語が en になり、端末に覚える（#487）', async () => {
        render(<LanguageRow />);
        const trigger = screen.getByRole('combobox');
        expect(trigger.textContent).toBe('日本語');
        // Radix の Select はキーで開ける（jsdom ではポインターで開けない）
        fireEvent.keyDown(trigger, { key: 'Enter' });
        fireEvent.click(await screen.findByRole('option', { name: 'English' }));
        expect(getLanguage()).toBe('en');
        expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
        expect(screen.getByRole('combobox').textContent).toBe('English');
        // 英訳（#497）までは <html lang> は ja のまま
        expect(document.documentElement.lang).toBe('ja');
    });
});
