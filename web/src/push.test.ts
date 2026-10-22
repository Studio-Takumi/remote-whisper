import { describe, expect, it } from 'vitest';

import { keyBytes, pushSupport, pushSupportMessage } from '@/push';

const ok = {
    isSecureContext: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    permission: 'default' as NotificationPermission,
};

describe('pushSupport', () => {
    it('HTTPS で、Service Worker・Push・通知があれば使える', () => {
        expect(pushSupport(ok)).toBe('ok');
        expect(pushSupport({ ...ok, permission: 'granted' })).toBe('ok');
    });

    it('http では使えない', () => {
        expect(pushSupport({ ...ok, isSecureContext: false })).toBe('insecure');
    });

    it('Push のないブラウザ（ホーム画面に追加していない iPhone など）では使えない', () => {
        expect(pushSupport({ ...ok, hasPushManager: false })).toBe('unsupported');
        expect(pushSupport({ ...ok, hasNotification: false, permission: null })).toBe('unsupported');
    });

    it('許可しなかったら、ブラウザの設定で許可し直すように出す', () => {
        expect(pushSupport({ ...ok, permission: 'denied' })).toBe('denied');
        expect(pushSupportMessage('denied')).toContain('ブラウザの設定');
        expect(pushSupportMessage('unsupported')).toContain('iOS 16.4');
    });
});

describe('keyBytes', () => {
    it('base64url の公開鍵をバイト列にする', () => {
        // 0x04 0xfb 0xff は base64url で BPv_
        expect(Array.from(keyBytes('BPv_'))).toEqual([0x04, 0xfb, 0xff]);
        expect(keyBytes('BPv_AA').length).toBe(4);
    });
});
