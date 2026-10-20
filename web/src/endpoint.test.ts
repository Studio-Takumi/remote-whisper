import { describe, expect, it } from 'vitest';

import { apiUrl, authLoginUrl, detectMode, healthzUrl, meUrl, parseCloudHosts, wsUrl } from '@/endpoint';

describe('モードの判定', () => {
    it('既定のクラウド用ドメインはクラウド版', () => {
        expect(detectMode('rw-dev.studio-takumi.dev', parseCloudHosts(undefined))).toBe('cloud');
    });
    it('それ以外（localhost・LAN・Tailscale）はダイレクト版', () => {
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
        expect(parseCloudHosts('')).toEqual(['rw-dev.studio-takumi.dev']);
    });
});

describe('URL の組み立て', () => {
    it('ダイレクト版は今のまま', () => {
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
