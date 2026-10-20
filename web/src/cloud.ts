// クラウド版の入口の状態（#156。docs/spec/cloud.md 10.2 節）。
// ログイン → 同意 → ホストの選択 → つながった、の順に進む。中身の画面は #155・#162・#161 で作る。
// ダイレクト版ではこの状態を使わない
import { create } from 'zustand';

import { setHostId } from '@/endpoint';
import { useHostsStore } from '@/hosts';

export type CloudStage = 'login' | 'consent' | 'hosts' | 'ready';

export type CloudState = { stage: CloudStage; hostId?: string };

export type CloudEvent =
    // ログインできた。同意がまだなら consent へ
    | { type: 'loggedIn'; consented: boolean }
    | { type: 'consented' }
    | { type: 'hostSelected'; hostId: string }
    // つなぎ先を選び直す
    | { type: 'changeHost' }
    | { type: 'loggedOut' };

export const initialCloudState: CloudState = { stage: 'login' };

// 順番に合わない出来事は無視する（状態をそのまま返す）
export function cloudReducer(state: CloudState, event: CloudEvent): CloudState {
    switch (event.type) {
        case 'loggedIn':
            return state.stage === 'login' ? { stage: event.consented ? 'hosts' : 'consent' } : state;
        case 'consented':
            return state.stage === 'consent' ? { stage: 'hosts' } : state;
        case 'hostSelected':
            return state.stage === 'hosts' && event.hostId !== '' ? { stage: 'ready', hostId: event.hostId } : state;
        case 'changeHost':
            return state.stage === 'ready' ? { stage: 'hosts' } : state;
        case 'loggedOut':
            return initialCloudState;
    }
}

// 画面（今のアプリ）を出してよいのは、ホストにつながったときだけ
export function isReady(state: CloudState) {
    return state.stage === 'ready' && !!state.hostId;
}

type CloudStore = { cloud: CloudState; dispatch: (event: CloudEvent) => void };

export const useCloudStore = create<CloudStore>((set, get) => ({
    cloud: initialCloudState,
    dispatch: (event) => {
        const next = cloudReducer(get().cloud, event);
        // API・WebSocket の URL に使うホストも、ここで合わせる
        setHostId(isReady(next) ? (next.hostId ?? null) : null);
        // ログアウトしたら、ホストの一覧と「自動でつないだ」を忘れる（次にログインした人は自動でつなぐ）
        if (event.type === 'loggedOut') {
            useHostsStore.getState().reset();
        }
        set({ cloud: next });
    },
}));
