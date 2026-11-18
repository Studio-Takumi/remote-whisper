import { demoIndex, loadDemoReplay, loadDemoSession } from 'virtual:rw-demo-data';

import { isDemoBuild } from '@/api/demoBuild';
import { ReplayView } from '@/api/demoReplayView';
import { DemoServer } from '@/api/demoServer';

// デモ版のビルドは URL に関係なく常にデモ（#413）。ほかでは URL に ?demo を付けると、サーバーのデータではなく
// mock.ts のダミーデータを出す（説明用のスクリーンショットを撮るため）
export const isDemo = isDemoBuild || new URLSearchParams(location.search).has('demo');

// リプレイ（#416）。同梱したデータに replay/ があるときだけ。view は再生した時刻での一覧の行・中身の形、load は記録を読む
const replayTarget = isDemo ? demoIndex?.replay : undefined;
export const demoReplay = replayTarget
    ? { target: replayTarget, view: new ReplayView(replayTarget), load: loadDemoReplay }
    : null;

// 同梱したデータ（ビルド時の RW_DEMO_DATA）で API に答えるもの。データがなければ null で、mock.ts のダミーデータを出す
export const demoServer =
    isDemo && demoIndex ? new DemoServer(demoIndex, loadDemoSession, demoReplay?.view ?? null) : null;

// mock.ts のダミーデータで動くデモか（?demo か、データなしでビルドしたデモ版）。プロジェクトとセッションを最初から手元に持ち、
// API で取らない。同梱したデータのデモ版は、ふだんと同じく API（demoServer）で取る
export const usesMockData = isDemo && demoServer === null;
