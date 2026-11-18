import { demoIndex, loadDemoSession } from 'virtual:rw-demo-data';

import { DemoServer } from '@/api/demoServer';

// デモ版のビルド（demo ブランチ。vite.config.ts で true、テストでは false）
declare const __DEMO_BUILD__: boolean;

// デモ版のビルドは URL に関係なく常にデモ（#413）。ほかでは URL に ?demo を付けると、サーバーのデータではなく
// mock.ts のダミーデータを出す（説明用のスクリーンショットを撮るため）
export const isDemo = __DEMO_BUILD__ || new URLSearchParams(location.search).has('demo');

// 同梱したデータ（ビルド時の RW_DEMO_DATA）で API に答えるもの。データがなければ null で、mock.ts のダミーデータを出す
export const demoServer = isDemo && demoIndex ? new DemoServer(demoIndex, loadDemoSession) : null;

// mock.ts のダミーデータで動くデモか（?demo か、データなしでビルドしたデモ版）。プロジェクトとセッションを最初から手元に持ち、
// API で取らない。同梱したデータのデモ版は、ふだんと同じく API（demoServer）で取る
export const usesMockData = isDemo && demoServer === null;
