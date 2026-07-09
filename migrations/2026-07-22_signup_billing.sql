-- LPからのセルフ利用登録＋Stripe定期課金＋施設自動作成の基盤。冪等。
-- ・plans に料金(price)と Stripe価格ID(stripe_price_id) を追加
-- ・facilities に課金状態(Stripe顧客/サブスク/状態/期末)を追加
-- ・signup_requests: 申込〜施設作成完了までの保留レコード(Webhook冪等の起点)
-- ・password_setup_tokens: パスワード設定/再設定リンク用トークン(ハッシュ保存)

-- 料金プラン
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;         -- 月額(税抜, 円)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(64);              -- StripeのPrice ID(有料のみ)
COMMENT ON COLUMN plans.price IS '月額(税抜, 円)。0は無料。';
COMMENT ON COLUMN plans.stripe_price_id IS 'Stripe価格ID(定期課金用。無料はNULL)';

-- 既知の料金を反映(LP掲載額に合わせる)
UPDATE plans SET price = 0    WHERE code = 'free';
UPDATE plans SET price = 980  WHERE code = 'light';
UPDATE plans SET price = 1980 WHERE code = 'standard';
UPDATE plans SET price = 4980 WHERE code = 'pro';

-- 施設の課金状態
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64);
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64);
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS billing_status VARCHAR(16) NOT NULL DEFAULT 'none';  -- none/active/past_due/canceled
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
COMMENT ON COLUMN facilities.billing_status IS '課金状態(none=無料/未課金, active=課金中, past_due=支払失敗, canceled=解約)';

-- 申込保留(施設作成完了までの一時レコード。Webhook/疑似決済の冪等キー)
CREATE TABLE IF NOT EXISTS signup_requests (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    facility_name          VARCHAR(255) NOT NULL,
    email                  VARCHAR(255) NOT NULL,          -- 管理者ログインID(メール)
    plan_code              VARCHAR(16)  NOT NULL REFERENCES plans(code),
    status                 VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending/completed/canceled/error
    stripe_session_id      VARCHAR(128),
    stripe_customer_id     VARCHAR(64),
    stripe_subscription_id VARCHAR(64),
    facility_id            BIGINT REFERENCES facilities(id),  -- 完了時に紐付く
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ,
    expires_at             TIMESTAMPTZ  NOT NULL DEFAULT (now() + INTERVAL '1 day')
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status  ON signup_requests(status);
CREATE INDEX IF NOT EXISTS idx_signup_requests_session ON signup_requests(stripe_session_id);
COMMENT ON TABLE signup_requests IS 'LP申込〜施設自動作成完了までの保留レコード';

-- パスワード設定/再設定トークン(生トークンは保存せずSHA-256ハッシュのみ保存)
CREATE TABLE IF NOT EXISTS password_setup_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL,                  -- sha256(hex)
    purpose     VARCHAR(16) NOT NULL DEFAULT 'setup',  -- setup/reset
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pw_token_hash ON password_setup_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_pw_token_user ON password_setup_tokens(user_id);
COMMENT ON TABLE password_setup_tokens IS 'パスワード設定/再設定リンク用トークン(ハッシュ保存)';
