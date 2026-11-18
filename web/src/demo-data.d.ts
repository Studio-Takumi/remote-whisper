// デモ版（#413）のデータ。ビルド時に vite/demoDataPlugin.ts が作る。データがなければ demoIndex は null
declare module 'virtual:rw-demo-data' {
    import type { DemoIndex, DemoSession } from '@/api/demoTypes';

    export const demoIndex: DemoIndex | null;
    export function loadDemoSession(projectId: string, sessionId: string): Promise<DemoSession> | null;
}
