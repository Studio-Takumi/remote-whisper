// 画面をアプリに同梱したときの接続先（#440。spec/mobile.md 11.8）
import { describe, expect, it } from 'vitest';

import { loadAppEndpoint, normalizeEndpointUrl, saveAppEndpoint } from '@/features/native/appEndpoint';

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    };
}

describe('URL をそろえる', () => {
    it('パスのないオリジンにする。scheme を書かなければ https', () => {
        expect(normalizeEndpointUrl('https://PC.example.ts.net/')).toBe('https://pc.example.ts.net');
        expect(normalizeEndpointUrl(' pc.example.ts.net ')).toBe('https://pc.example.ts.net');
        expect(normalizeEndpointUrl('http://192.168.0.5:8000')).toBe('http://192.168.0.5:8000');
        expect(normalizeEndpointUrl('https://pc.example:443')).toBe('https://pc.example');
    });
    it('http(s) 以外・資格情報・パス・? # は受け付けない', () => {
        for (const bad of [
            '',
            'ftp://pc.example',
            'javascript:alert(1)',
            'capacitor://localhost',
            'https://user:pw@pc.example',
            'https://rw.example@evil.example',
            'https://pc.example/path',
            'https://pc.example/?x=1',
            'https://pc.example/#a',
            'https://',
        ]) {
            expect(normalizeEndpointUrl(bad), bad).toBeNull();
        }
    });
});

describe('保存と読み出し', () => {
    it('保存したものを読み出せる。消せる', () => {
        const storage = memoryStorage();
        expect(loadAppEndpoint(storage)).toBeNull();
        expect(saveAppEndpoint({ url: 'https://pc.example', mode: 'direct' }, storage)).toBe(true);
        expect(loadAppEndpoint(storage)).toEqual({ url: 'https://pc.example', mode: 'direct' });
        saveAppEndpoint(null, storage);
        expect(loadAppEndpoint(storage)).toBeNull();
    });
    it('壊れた値・形の違う値は読まない', () => {
        const key = 'remote-whisper.appEndpoint';
        for (const raw of [
            '{',
            'null',
            '{"url":"https://pc.example"}',
            '{"url":"https://pc.example","mode":"other"}',
            '{"url":"javascript:alert(1)","mode":"direct"}',
            '{"url":"https://pc.example/path","mode":"direct"}',
        ]) {
            expect(loadAppEndpoint(memoryStorage({ [key]: raw })), raw).toBeNull();
        }
    });
    it('ストレージが使えなくても落ちない', () => {
        const broken = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
            removeItem: () => {
                throw new Error('denied');
            },
        };
        expect(loadAppEndpoint(broken)).toBeNull();
        expect(saveAppEndpoint({ url: 'https://pc.example', mode: 'direct' }, broken)).toBe(false);
        expect(saveAppEndpoint(null, null)).toBe(false);
    });
});
