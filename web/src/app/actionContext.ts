// ストアのアクションの中身（features/*/…Actions.ts）に渡すもの。ストアごとに 1 つ作る
import type { AppStore } from '@/app/appState';
import type { StatusReceiver } from '@/app/serverStatus';
import type { SessionSync } from '@/app/sessionSync';
import type { Recorder } from '@/features/recording/recorderState';

export type ActionContext = {
    store: AppStore;
    recorder: Recorder;
    sessions: SessionSync;
    status: StatusReceiver;
};
