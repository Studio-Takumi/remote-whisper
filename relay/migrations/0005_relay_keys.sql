-- Worker の中で使う鍵（#252）。今は接続元のハッシュ（pairing_requests.client_hash）の HMAC の鍵だけ。
-- 初めて要るときに Worker が乱数で作って入れる（Worker の secret を増やさない）。spec/cloud.md 10.6
CREATE TABLE relay_keys (
    name TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
