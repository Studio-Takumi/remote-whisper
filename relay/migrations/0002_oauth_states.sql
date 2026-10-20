-- ログイン（OAuth）の途中の状態（#155）。state のハッシュと PKCE の値を、ログインを始めてから
-- 戻ってくるまでの間だけ置く（10 分・1 回だけ）。Cookie に入れると署名用の鍵が要るので、DB に置く
CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'discord', 'github')),
    code_verifier TEXT NOT NULL,
    -- ログインのあとに戻る画面のパス（同じオリジンのパスだけ）
    return_to TEXT NOT NULL,
    -- ログインしている人がログイン手段を足すとき、その人の ID
    link_user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expires ON oauth_states (expires_at);
