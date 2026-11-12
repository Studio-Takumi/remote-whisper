import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LlmSection } from '@/components/SettingsDialog';
import { type Settings, defaultSettings } from '@/settings';
import { initialServerStatus, llmUnavailable, summaryStatus } from '@/status';

// 設定モーダルの「要約」ページの上の、要約に使うアプリと接続先（#327）

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'sk-lm-secret-token';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function settings(backend: 'ollama' | 'lmstudio', lmstudio: Partial<NonNullable<Settings['lmstudio']>> = {}): Settings {
    return {
        ...defaultSettings,
        llm: { backend },
        lmstudio: { ...defaultSettings.lmstudio!, ...lmstudio },
    };
}

function render(draft: Settings, saved: Settings = draft) {
    const changes: unknown[] = [];
    act(() =>
        root.render(
            createElement(LlmSection, {
                draft,
                saved,
                onChangeBackend: (b) => changes.push({ backend: b }),
                onChangeOllamaHost: (h) => changes.push({ host: h }),
                onChangeLmStudio: (p) => changes.push(p),
            }),
        ),
    );
    return changes;
}

describe('要約に使うアプリ', () => {
    it('Ollama を選んでいれば Ollama の URL だけを出す', () => {
        render(settings('ollama'));
        expect(host.querySelector('#ollama-host')).not.toBeNull();
        expect(host.querySelector('#lmstudio-host')).toBeNull();
        expect(host.querySelector('#lmstudio-token')).toBeNull();
        expect(host.textContent).toContain('Ollama');
    });

    it('LM Studio を選んでいれば、LM Studio の URL とトークンを出す', () => {
        render(settings('lmstudio'));
        expect(host.querySelector('#ollama-host')).toBeNull();
        expect((host.querySelector('#lmstudio-host') as HTMLInputElement).value).toBe('http://localhost:1234');
        expect(host.textContent).toContain('LM Studio で認証を求める設定にしたときだけ入れます');
    });

    it('トークンは表示せず、設定済みかどうかだけを出す', () => {
        // サーバーはトークンを返さない（tokenSet だけ）。入れた値も、伏せ字の欄にしか入らない
        const draft = settings('lmstudio', { tokenSet: true, token: SECRET });
        render(draft, settings('lmstudio', { tokenSet: true }));
        const input = host.querySelector('#lmstudio-token') as HTMLInputElement;
        expect(input.type).toBe('password');
        expect(host.textContent).not.toContain(SECRET);
        expect(host.textContent).toContain('設定済みです');
    });

    it('消すのは明示的な操作で、保存すると null を送る', () => {
        const saved = settings('lmstudio', { tokenSet: true });
        const changes = render(saved);
        const clear = [...host.querySelectorAll('button')].find((b) => b.textContent === '消す');
        expect(clear).toBeDefined();
        act(() => clear!.click());
        expect(changes).toContainEqual({ token: null });
        // 消すことにしたら、そう出す（やめることもできる）
        render(settings('lmstudio', { tokenSet: true, token: null }), saved);
        expect(host.textContent).toContain('保存すると消えます');
        expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'やめる')).toBe(true);
    });

    it('未設定なら消すボタンを出さない', () => {
        render(settings('lmstudio'));
        expect([...host.querySelectorAll('button')].some((b) => b.textContent === '消す')).toBe(false);
    });
});

describe('接続できないときの表示', () => {
    it('選んでいるほうの状態だけを見る', () => {
        const lmsDown = { ...initialServerStatus, lmstudio: 'error' as const };
        expect(llmUnavailable(lmsDown, 'lmstudio')).toBe(true);
        expect(llmUnavailable(lmsDown, 'ollama')).toBe(false);
        const ollamaDown = { ...initialServerStatus, ollama: 'error' as const };
        expect(llmUnavailable(ollamaDown, 'lmstudio')).toBe(false);
        expect(summaryStatus('recording', lmsDown, 5, 'lmstudio')?.text).toBe(
            'LM Studio に接続できず、要約を作れません。録音を終えてから再生成できます',
        );
        expect(summaryStatus('recording', ollamaDown, 5, 'ollama')?.text).toContain('Ollama に接続できず');
        expect(summaryStatus('recording', ollamaDown, 5, 'lmstudio')?.tone).toBe('active');
    });
});
