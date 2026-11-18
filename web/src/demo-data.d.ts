// デモ版（#413）のデータ。ビルド時に vite/demoDataPlugin.ts が作る。データがなければ demoIndex は null
declare module 'virtual:rw-demo-data' {
    import type { DemoIndex, DemoReplay, DemoSession } from '@/api/demoTypes';

    export const demoIndex: DemoIndex | null;
    export function loadDemoSession(projectId: string, sessionId: string): Promise<DemoSession> | null;
    // リプレイ（#416）の記録。replay/ がなければ null
    export function loadDemoReplay(): Promise<DemoReplay> | null;
}
