import { useEffect, useState } from 'react';

import { type DirListing, api } from '@/api';

// ディレクトリの中身（GET /api/fs）。path を省略すると、読み込めるフォルダ（materials.roots）の一覧
// enabled が false の間は取りに行かない（ツリーの閉じているフォルダの分は取らない）
export function useDirListing(path: string | null, enabled = true) {
    const [state, setState] = useState<{ key: string; listing: DirListing | null; error: string | null }>({
        key: '',
        listing: null,
        error: null,
    });
    const key = path ?? '';

    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        const query = path === null ? '' : `?path=${encodeURIComponent(path)}`;
        api.get<DirListing>(`/api/fs${query}`)
            .then((listing) => !cancelled && setState({ key, listing, error: null }))
            .catch((e: Error) => !cancelled && setState({ key, listing: null, error: e.message }));
        return () => {
            cancelled = true;
        };
    }, [key, path, enabled]);

    const current = state.key === key ? state : { listing: null, error: null };
    return { listing: current.listing, error: current.error, loading: enabled && !current.listing && !current.error };
}
