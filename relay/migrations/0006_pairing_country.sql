-- 申請した接続元の国（#251）。spec/cloud.md 10.6
-- Cloudflare の request.cf.country（ISO 3166-1 の 2 文字。Tor は T1）。IP も地域（都道府県など）も置かない。
-- 確認の画面で、承認する人の接続元の国と比べて、違えば強く知らせる。わからない（request.cf がない・XX）ときは NULL
ALTER TABLE pairing_requests ADD COLUMN client_country TEXT;
