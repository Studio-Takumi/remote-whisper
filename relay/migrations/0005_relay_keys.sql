-- Worker の中で使う鍵（#252）。今は接続元のハッシュ（pairing_requests.client_hash）の HMAC の鍵だけ。
-- 初めて要るときに Worker が乱数で作って入れる（Worker の secret を増やさない）。spec/cloud.md 10.6
-- 守れるのは client_hash の列だけが漏れたとき。鍵も同じ D1 にあるので、D1 ごと（エクスポート・
-- Time Travel・バックアップ）を持つ人は今でも IP を戻せる。分けるなら鍵を Worker の secret に移す
CREATE TABLE relay_keys (
    name TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
