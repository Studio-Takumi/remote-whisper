import type { CapacitorConfig } from '@capacitor/cli';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// アプリの中で開くセルフホスト版の URL（spec/mobile.md 11.2）。リポジトリは公開なので、URL はコミットしない。
// 環境変数 RW_SERVER_URL か、Git に入れない mobile/.env.local から読む（書き方は .env.example）。
// 環境変数があればそちらを優先する（loadEnvFile は、もう決まっている環境変数を上書きしない）
const envFile = resolve(__dirname, '.env.local');
if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
}
const serverUrl = process.env.RW_SERVER_URL?.trim() || undefined;
if (!serverUrl) {
    console.warn(
        '[remote-whisper] RW_SERVER_URL が決まっていません。アプリは同梱の web/dist を開き、ホストにはつながりません（mobile/README.md）',
    );
}

const config: CapacitorConfig = {
    // 公開してよい ID（Capacitor はハイフンを許さないので studiotakumi）。手元で変えるときは
    // ios/App/Local.xcconfig の PRODUCT_BUNDLE_IDENTIFIER（README）
    appId: 'dev.studiotakumi.remotewhisper',
    appName: 'Remote Whisper',
    // server.url で開くので中身は表示に使わないが、cap sync が要る。web/ のコピーは作らない
    webDir: '../web/dist',
    server: serverUrl ? { url: serverUrl } : undefined,
};

export default config;
