-- クラウド版の中間サーバーの DB（仕様書 spec/cloud.md 10.8）。
-- 音声・文字起こし・要約・プロジェクト名は置かない。時刻は UNIX ミリ秒。
-- マイグレーションは足すだけにする（列や表を消す・名前を変えるものは 2 回に分けて出す）

-- ユーザー。ログイン手段（auth_identities）を 1 つ以上持つ
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    -- 初めに同意した利用規約の版。同意する前は NULL（10.11 節）
    tos_version TEXT,
    created_at INTEGER NOT NULL
);

-- ログイン手段。同じプロバイダの同じ ID なら同じユーザー。メールアドレスで自動に紐付けはしない
CREATE TABLE auth_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'discord', 'github')),
    provider_subject TEXT NOT NULL,
    -- 表示用。紐付けには使わない
    email TEXT,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, provider_subject)
);
CREATE INDEX auth_identities_user ON auth_identities (user_id);

-- ログインセッション。Cookie の値そのものは置かず、ハッシュだけ
CREATE TABLE web_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_user ON web_sessions (user_id);
CREATE INDEX web_sessions_expires ON web_sessions (expires_at);

-- ホスト（ユーザーの PC）。解除したら行を消す（同じホスト ID は使い回さない）
CREATE TABLE hosts (
    -- ホストが作った UUID
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Ed25519 の公開鍵（ホストから Worker への API の署名を確かめる）
    public_key TEXT NOT NULL,
    -- 中継の鍵（Worker からホストへの署名。10.5 節）
    -- 置き方は未決（D1 に置く・暗号化する・都度導出する。10.8 節）なので NULL を許す
    relay_key TEXT,
    tunnel_id TEXT,
    tunnel_hostname TEXT UNIQUE,
    app_version TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
);
CREATE INDEX hosts_user ON hosts (user_id);

-- ホストの登録の申請。登録コードはハッシュだけ置く。10 分有効・1 回だけ
CREATE TABLE pairing_requests (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    host_id TEXT NOT NULL,
    host_name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    -- 承認・拒否した人
    user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX pairing_requests_expires ON pairing_requests (expires_at);
CREATE INDEX pairing_requests_host ON pairing_requests (host_id);

-- 同意の履歴（追記だけ）。今の状態は、その種類の最後の行
CREATE TABLE consents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
    -- 同意した文面の版
    version TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX consents_user ON consents (user_id, kind, created_at);
