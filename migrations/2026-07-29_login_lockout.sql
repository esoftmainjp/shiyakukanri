-- ログイン失敗によるアカウントロック用。冪等・非破壊。
-- 連続失敗回数がしきい値に達したら locked_until までログインを拒否する(成功でリセット)。
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
COMMENT ON COLUMN users.failed_login_count IS '連続ログイン失敗回数(成功でリセット)';
COMMENT ON COLUMN users.locked_until       IS 'アカウントロック解除時刻(NULL=ロックなし)';
