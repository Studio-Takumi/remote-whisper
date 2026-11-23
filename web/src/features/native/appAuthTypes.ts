// iOS アプリの、クラウド版のログインのプラグイン（AppAuth。#441）の、JS 向けの型。正本は spec/mobile.md 11.10
export interface AppAuthPlugin {
    // システムのログイン画面を出し、戻ってきたコードをトークンに替えてアプリの中（Keychain）に置く。
    // origin は中間サーバーのオリジン（https://…）。やめたら code が 'canceled' の Error で reject
    login(options: { origin: string; provider: string }): Promise<void>;
    // 使えるアクセストークン（期限が近ければ更新してから）。ログインしていなければ null。更新トークンは渡さない
    accessToken(options: { origin: string }): Promise<{ token: string | null }>;
    // 中間サーバーのこの端末を消し、アプリの中のトークンも消す
    logout(options: { origin: string }): Promise<void>;
    // アプリの中のトークンだけを消す（すべての端末からログアウト・退会のあと）
    forget(options: { origin: string }): Promise<void>;
}
