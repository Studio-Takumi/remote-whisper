-- 録音ごとの数字（#206）の回数の制限に使う。1 ユーザーあたり 1 時間に 60 件まで。spec/cloud.md 10.9
-- 受け付けた時刻だけを置く（中身は置かない）。1 時間を過ぎた行は、次に受け付けるときに消す
CREATE TABLE recording_metric_posts (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    posted_at INTEGER NOT NULL
);
CREATE INDEX recording_metric_posts_user ON recording_metric_posts (user_id, posted_at);
