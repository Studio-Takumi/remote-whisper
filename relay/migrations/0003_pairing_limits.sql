-- ホストの登録（#157）の回数の制限に使う列。spec/cloud.md 10.6
-- 申請した接続元（IP アドレスのハッシュ。IP そのものは置かない）と、最後に /pair/poll を聞かれた時刻
ALTER TABLE pairing_requests ADD COLUMN client_hash TEXT;
ALTER TABLE pairing_requests ADD COLUMN last_polled_at INTEGER;
CREATE INDEX pairing_requests_client ON pairing_requests (client_hash, created_at);
-- 同じホスト ID の申請は 1 つだけ（同時に申請されても 2 行にならない。期限切れの行は申請の前に消す）
-- 作る前に、同じホスト ID の行が重なっていれば古いものを消す（申請は 10 分で切れるので消してよい）
DELETE FROM pairing_requests WHERE rowid NOT IN (SELECT MAX(rowid) FROM pairing_requests GROUP BY host_id);
DROP INDEX IF EXISTS pairing_requests_host;
CREATE UNIQUE INDEX pairing_requests_host ON pairing_requests (host_id);
