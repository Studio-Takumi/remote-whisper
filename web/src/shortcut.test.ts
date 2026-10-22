import { afterEach, describe, expect, it } from 'vitest';

import {
    ariaShortcut,
    captureShortcut,
    formatShortcut,
    isModalOpen,
    isTypingTarget,
    matchesShortcut,
    shouldHandleMicShortcut,
} from '@/shortcut';

function key(code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) {
    return { code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta };
}

describe('captureShortcut', () => {
    it('修飾キーとキーを決まった順でつなぐ', () => {
        expect(captureShortcut(key('KeyM', { shift: true, alt: true }))).toEqual({
            kind: 'combo',
            combo: 'Alt+Shift+KeyM',
        });
        expect(captureShortcut(key('Digit1', { meta: true, ctrl: true }))).toEqual({
            kind: 'combo',
            combo: 'Ctrl+Meta+Digit1',
        });
    });

    it('修飾キーがなければ受け付けない', () => {
        expect(captureShortcut(key('KeyM'))).toEqual({ kind: 'needsModifier' });
    });

    it('修飾キーだけを押している間は待つ', () => {
        expect(captureShortcut(key('ShiftLeft', { shift: true }))).toEqual({ kind: 'waiting' });
        expect(captureShortcut(key('AltRight', { alt: true, shift: true }))).toEqual({ kind: 'waiting' });
        expect(captureShortcut(key('MetaLeft', { meta: true }))).toEqual({ kind: 'waiting' });
    });
});

describe('matchesShortcut', () => {
    it('修飾キーが過不足なく同じときだけ', () => {
        expect(matchesShortcut(key('KeyM', { alt: true, shift: true }), 'Alt+Shift+KeyM')).toBe(true);
        expect(matchesShortcut(key('KeyM', { alt: true }), 'Alt+Shift+KeyM')).toBe(false);
        expect(matchesShortcut(key('KeyM', { alt: true, shift: true, ctrl: true }), 'Alt+Shift+KeyM')).toBe(false);
        expect(matchesShortcut(key('KeyN', { alt: true, shift: true }), 'Alt+Shift+KeyM')).toBe(false);
    });

    it('使わない（空）なら何にも当たらない', () => {
        expect(matchesShortcut(key('KeyM', { alt: true, shift: true }), '')).toBe(false);
    });
});

describe('formatShortcut', () => {
    it('Mac は記号、それ以外は + でつなぐ', () => {
        expect(formatShortcut('Alt+Shift+KeyM', true)).toBe('⌥⇧M');
        expect(formatShortcut('Alt+Shift+KeyM', false)).toBe('Alt+Shift+M');
        expect(formatShortcut('Ctrl+Meta+Digit1', false)).toBe('Ctrl+Win+1');
        expect(formatShortcut('Ctrl+ArrowUp', true)).toBe('⌃↑');
        expect(formatShortcut('Alt+F2', false)).toBe('Alt+F2');
        expect(formatShortcut('', false)).toBe('');
    });

    it('aria-keyshortcuts の形', () => {
        expect(ariaShortcut('Ctrl+Alt+KeyM')).toBe('Control+Alt+M');
        expect(ariaShortcut('')).toBeUndefined();
    });
});

describe('効かないところ', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('文字を入力する欄', () => {
        document.body.innerHTML = `
            <input id="text" />
            <input id="check" type="checkbox" />
            <textarea id="area"></textarea>
            <div id="editable" contenteditable="true"></div>
            <button id="button"></button>`;
        const el = (id: string) => document.getElementById(id);
        expect(isTypingTarget(el('text'))).toBe(true);
        expect(isTypingTarget(el('area'))).toBe(true);
        expect(isTypingTarget(el('check'))).toBe(false);
        expect(isTypingTarget(el('button'))).toBe(false);
        expect(isTypingTarget(document.body)).toBe(false);
    });

    it('モーダルが開いている', () => {
        expect(isModalOpen()).toBe(false);
        document.body.innerHTML = '<div role="dialog"></div>';
        expect(isModalOpen()).toBe(true);
        document.body.innerHTML = '<div role="alertdialog"></div>';
        expect(isModalOpen()).toBe(true);
    });

    it('shouldHandleMicShortcut は入力中・モーダル・キーの押しっぱなしでは false', () => {
        const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
            let handled = false;
            target.addEventListener(
                'keydown',
                (e) => {
                    handled = shouldHandleMicShortcut(e as KeyboardEvent, 'Alt+Shift+KeyM');
                },
                { once: true },
            );
            target.dispatchEvent(
                new KeyboardEvent('keydown', { code: 'KeyM', altKey: true, shiftKey: true, bubbles: true, ...init }),
            );
            return handled;
        };
        document.body.innerHTML = '<input id="text" />';
        expect(press(document.body)).toBe(true);
        expect(press(document.body, { repeat: true })).toBe(false);
        expect(press(document.body, { isComposing: true })).toBe(false);
        expect(press(document.body, { shiftKey: false })).toBe(false);
        expect(press(document.getElementById('text')!)).toBe(false);
        document.body.innerHTML = '<div role="dialog"></div>';
        expect(press(document.body)).toBe(false);
    });
});
