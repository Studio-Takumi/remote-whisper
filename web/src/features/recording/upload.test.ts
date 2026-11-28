import { describe, expect, it } from 'vitest';

import { sourceUploadUrl, uploadError, uploadUrl } from '@/features/recording/upload';

describe('uploadUrl', () => {
    it('ファイル名と更新日時をクエリにする', () => {
        const url = uploadUrl('D--work-a1b2c3', { name: '会議 1.m4a', lastModified: 1760000000000 });
        expect(url).toBe(
            '/api/projects/D--work-a1b2c3/sessions/upload?name=%E4%BC%9A%E8%AD%B0+1.m4a&lastModified=1760000000000&displayLanguage=ja',
        );
    });

    it('まとめるときはファイルの数を sources に付ける（#357）', () => {
        expect(uploadUrl('p', { name: 'a.mp3', lastModified: 1 }, 3)).toBe(
            '/api/projects/p/sessions/upload?name=a.mp3&lastModified=1&sources=3&displayLanguage=ja',
        );
    });

    it('今回だけ変えた文字起こしの言語を language に付ける（#482）', () => {
        expect(uploadUrl('p', { name: 'a.mp3', lastModified: 1 }, undefined, 'auto')).toBe(
            '/api/projects/p/sessions/upload?name=a.mp3&lastModified=1&language=auto&displayLanguage=ja',
        );
        expect(uploadUrl('p', { name: 'a.mp3', lastModified: 1 }, undefined, null)).toBe(
            '/api/projects/p/sessions/upload?name=a.mp3&lastModified=1&displayLanguage=ja',
        );
    });

    it('この端末の表示言語を displayLanguage に付ける（#498）', () => {
        expect(uploadUrl('p', { name: 'a.mp3', lastModified: 1 }, undefined, null, 'en')).toBe(
            '/api/projects/p/sessions/upload?name=a.mp3&lastModified=1&displayLanguage=en',
        );
    });
});

describe('sourceUploadUrl', () => {
    it('2 つ目以降のファイルは、作ったセッションの sources/upload に送る', () => {
        expect(sourceUploadUrl('p', '20261116-1000', { name: 'b.m4a', lastModified: 2 })).toBe(
            '/api/projects/p/sessions/20261116-1000/sources/upload?name=b.m4a&lastModified=2',
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
