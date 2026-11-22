import { describe, expect, it } from 'vitest';

import {
    apiUrl,
    authLoginUrl,
    bundled,
    detectMode,
    endpoint,
    healthzUrl,
    isBundled,
    meUrl,
    parseCloudHosts,
    resolveEndpoint,
    workerUrl,
    wsOrigin,
    wsUrl,
} from '@/api/endpoint';

describe('画面をアプリに同梱したとき（#440）', () => {
    const hosts = parseCloudHosts(undefined);
    it('アプリの中で http(s) でないオリジンのときだけ同梱とみなす（server.url は今まで通り）', () => {
        expect(isBundled({ protocol: 'capacitor:' }, true)).toBe(true);
        expect(isBundled({ protocol: 'https:' }, true)).toBe(false);
        expect(isBundled({ protocol: 'http:' }, true)).toBe(false);
        expect(isBundled({ protocol: 'capacitor:' }, false)).toBe(false);
    });
    it('ブラウザ版は同じオリジンの相対 URL のまま', () => {
        expect(bundled).toBe(false);
        expect(endpoint).toEqual({ base: '', mode: 'direct', unset: false });
        expect(resolveEndpoint('rw.studio-takumi.dev', hosts, null)).toEqual({ base: '', mode: 'cloud', unset: false });
    });
    it('同梱していれば、保存した接続先の URL とモードを使う。なければ unset', () => {
        expect(resolveEndpoint('localhost', hosts, { saved: null })).toEqual({ base: '', mode: 'direct', unset: true });
        expect(
            resolveEndpoint('localhost', hosts, { saved: { url: 'https://pc.example:8443', mode: 'direct' } }),
        ).toEqual({ base: 'https://pc.example:8443', mode: 'direct', unset: false });
        // モードはホスト名（localhost）ではなく、保存した値で決まる
        expect(
            resolveEndpoint('localhost', hosts, { saved: { url: 'https://rw.studio-takumi.dev', mode: 'cloud' } }).mode,
        ).toBe('cloud');
    });
    it('接続先があれば絶対 URL を組み立てる', () => {
        expect(apiUrl('/api/projects', 'direct', null, 'http://192.168.0.5:8000')).toBe(
            'http://192.168.0.5:8000/api/projects',
        );
        expect(apiUrl('/api/projects', 'cloud', 'h1', 'https://rw.studio-takumi.dev')).toBe(
            'https://rw.studio-takumi.dev/h/h1/api/projects',
        );
        expect(wsUrl(wsOrigin('https://pc.example:8443'), 'direct', null)).toBe('wss://pc.example:8443/ws');
        expect(wsUrl(wsOrigin('http://192.168.0.5:8000'), 'direct', null)).toBe('ws://192.168.0.5:8000/ws');
        expect(wsUrl(wsOrigin('https://rw.studio-takumi.dev'), 'cloud', 'h1')).toBe(
            'wss://rw.studio-takumi.dev/h/h1/ws',
        );
        expect(workerUrl('/me/hosts', 'https://rw.studio-takumi.dev')).toBe('https://rw.studio-takumi.dev/me/hosts');
    });
    it('接続先がなければ画面の location から（今まで通り）', () => {
        expect(wsOrigin('')).toBe(location);
        expect(apiUrl('/api/version', 'direct', null)).toBe('/api/version');
    });
});

describe('モードの判定', () => {
    it('既定のクラウド用ドメインはクラウド版', () => {
        expect(detectMode('rw-dev.studio-takumi.dev', parseCloudHosts(undefined))).toBe('cloud');
    });
    it('それ以外（localhost・LAN・Tailscale）はセルフホスト版', () => {
        const hosts = parseCloudHosts(undefined);
        expect(detectMode('localhost', hosts)).toBe('direct');
        expect(detectMode('192.168.0.5', hosts)).toBe('direct');
        expect(detectMode('machine.tail1234.ts.net', hosts)).toBe('direct');
    });
    it('カンマ区切りで複数渡せる。大文字小文字と空白は無視する', () => {
        const hosts = parseCloudHosts(' A.example.com, b.example.com ,');
        expect(hosts).toEqual(['a.example.com', 'b.example.com']);
        expect(detectMode('B.example.com', hosts)).toBe('cloud');
    });
    it('設定が空文字なら既定に戻る', () => {
        expect(parseCloudHosts('')).toEqual(['rw-dev.studio-takumi.dev', 'rw.studio-takumi.dev']);
    });
});

describe('URL の組み立て', () => {
    it('セルフホスト版は今のまま', () => {
        expect(apiUrl('/api/projects', 'direct', null)).toBe('/api/projects');
        expect(apiUrl('/api/projects', 'direct', 'h1')).toBe('/api/projects');
        expect(wsUrl({ protocol: 'http:', host: 'pc:8000' }, 'direct', null)).toBe('ws://pc:8000/ws');
        expect(wsUrl({ protocol: 'https:', host: 'pc.example' }, 'direct', null)).toBe('wss://pc.example/ws');
    });
    it('クラウド版は /h/<hostId>/ を前に付ける', () => {
        expect(apiUrl('/api/projects', 'cloud', 'h1')).toBe('/h/h1/api/projects');
        expect(wsUrl({ protocol: 'https:', host: 'rw-dev.studio-takumi.dev' }, 'cloud', 'h1')).toBe(
            'wss://rw-dev.studio-takumi.dev/h/h1/ws',
        );
    });
    it('クラウド版でホストが未選択ならエラー', () => {
        expect(() => apiUrl('/api/projects', 'cloud', null)).toThrow();
        expect(() => apiUrl('/api/projects', 'cloud', '')).toThrow();
        expect(() => wsUrl({ protocol: 'https:', host: 'x' }, 'cloud', null)).toThrow();
    });
    it('ホスト ID はエスケープする', () => {
        expect(apiUrl('/api/version', 'cloud', 'a/b')).toBe('/h/a%2Fb/api/version');
    });
    it('ホストに属さないパス', () => {
        expect(authLoginUrl('google')).toBe('/auth/login/google');
        expect(meUrl('/hosts')).toBe('/me/hosts');
        expect(healthzUrl()).toBe('/healthz');
    });
});
