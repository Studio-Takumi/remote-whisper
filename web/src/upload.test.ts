import { describe, expect, it } from 'vitest';

import { uploadError, uploadUrl } from '@/upload';

describe('uploadUrl', () => {
    it('ファイル名と更新日時をクエリにする', () => {
        const url = uploadUrl('D--work-a1b2c3', { name: '会議 1.m4a', lastModified: 1760000000000 });
        expect(url).toBe(
            '/api/projects/D--work-a1b2c3/sessions/upload?name=%E4%BC%9A%E8%AD%B0+1.m4a&lastModified=1760000000000',
        );
    });
});

describe('uploadError', () => {
    it('サーバーの理由（detail）を出す', () => {
        expect(uploadError(413, JSON.stringify({ detail: 'ファイルが大きすぎます' }))).toBe('ファイルが大きすぎます');
    });

    it('読めなければ状態コード、つながらなければ途中で切れた', () => {
        expect(uploadError(500, 'Internal Server Error')).toBe('ホストが受け付けませんでした（500）');
        expect(uploadError(0, '')).toBe('アップロードが途中で切れました');
    });
});
