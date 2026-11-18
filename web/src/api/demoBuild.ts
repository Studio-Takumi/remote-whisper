// デモ版のビルド（demo ブランチ。#413）か。vite.config.ts で true、テストでは false（テストは vi.mock で差し替える）
declare const __DEMO_BUILD__: boolean;

export const isDemoBuild: boolean = __DEMO_BUILD__;
