import { beforeEach, describe, expect, it } from 'vitest';

import { cloudReducer, initialCloudState, isReady, useCloudStore } from '@/cloud';
import { apiUrl } from '@/endpoint';

describe('クラウド版の入口の状態', () => {
    it('ログイン → 同意 → ホストの選択 → つながった の順に進む', () => {
        let s = initialCloudState;
        expect(s.stage).toBe('login');
        s = cloudReducer(s, { type: 'loggedIn', consented: false });
        expect(s.stage).toBe('consent');
        s = cloudReducer(s, { type: 'consented' });
        expect(s.stage).toBe('hosts');
        s = cloudReducer(s, { type: 'hostSelected', hostId: 'h1' });
        expect(s).toEqual({ stage: 'ready', hostId: 'h1' });
        expect(isReady(s)).toBe(true);
    });
    it('同意ずみなら同意を飛ばす', () => {
        expect(cloudReducer(initialCloudState, { type: 'loggedIn', consented: true }).stage).toBe('hosts');
    });
    it('順番に合わない出来事は無視する', () => {
        expect(cloudReducer(initialCloudState, { type: 'hostSelected', hostId: 'h1' })).toBe(initialCloudState);
        expect(cloudReducer(initialCloudState, { type: 'consented' })).toBe(initialCloudState);
    });
    it('ホストの選び直しとログアウト', () => {
        const ready = { stage: 'ready', hostId: 'h1' } as const;
        expect(cloudReducer(ready, { type: 'changeHost' })).toEqual({ stage: 'hosts' });
        expect(cloudReducer(ready, { type: 'loggedOut' })).toEqual(initialCloudState);
    });
    it('ホストにつながるまでは、アプリを出さない', () => {
        expect(isReady({ stage: 'hosts' })).toBe(false);
        expect(isReady({ stage: 'ready' })).toBe(false);
    });
    describe('store', () => {
        beforeEach(() => useCloudStore.getState().dispatch({ type: 'loggedOut' }));
        it('ホストを選ぶと API の URL に使うホストが入り、選び直すと外れる', () => {
            const { dispatch } = useCloudStore.getState();
            dispatch({ type: 'loggedIn', consented: true });
            dispatch({ type: 'hostSelected', hostId: 'h9' });
            expect(useCloudStore.getState().cloud.stage).toBe('ready');
            expect(apiUrl('/api/version', 'cloud')).toBe('/h/h9/api/version');
            dispatch({ type: 'changeHost' });
            expect(() => apiUrl('/api/version', 'cloud')).toThrow();
        });
    });
});
