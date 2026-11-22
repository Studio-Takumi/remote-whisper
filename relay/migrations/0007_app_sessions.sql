-- iOS アプリのログイン（#441）。spec/cloud.md 10.7 の「アプリのログイン」・10.8 節
-- トークン・コード・チケットはどれも値そのものは置かず、ハッシュだけ

-- アプリから始めたログインの途中の状態。アプリが作った PKCE の challenge（S256）と state を、
-- コールバックのあとアプリへ戻すときまで置く。ブラウザのログインでは NULL
ALTER TABLE oauth_states ADD COLUMN app_challenge TEXT;
ALTER TABLE oauth_states ADD COLUMN app_state TEXT;

-- アプリのログインセッション（端末ごとに 1 行）。アクセストークン（短い期限）と更新トークン（長い期限。
-- 使うたびに両方を替える）を持つ。行を消せば、どちらのトークンもすぐ使えなくなる（ログアウト・端末の削除）
CREATE TABLE app_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- 端末の名前（表示用。アプリが送る）
    name TEXT NOT NULL,
    access_hash TEXT NOT NULL UNIQUE,
    access_expires_at INTEGER NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    -- 更新トークンの期限（更新するたびに延びる）
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX app_sessions_user ON app_sessions (user_id);
CREATE INDEX app_sessions_expires ON app_sessions (expires_at);

-- ログインのあと、アプリに渡す一度だけのコード（短い期限）。トークンに替えるときに PKCE の verifier を確かめる
CREATE TABLE app_auth_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX app_auth_codes_expires ON app_auth_codes (expires_at);

-- ヘッダーを付けられない接続（WebSocket・音声の再生）のための短い期限のチケット。
-- 1 つのホストの 1 つのパスだけに使える。WebSocket（ws）は一度だけ、音声（media）は期限まで何度でも
CREATE TABLE app_tickets (
    ticket_hash TEXT PRIMARY KEY,
    app_session_id TEXT NOT NULL REFERENCES app_sessions (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ws', 'media')),
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX app_tickets_expires ON app_tickets (expires_at);
