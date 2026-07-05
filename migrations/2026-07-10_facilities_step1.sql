-- 施設別管理(マルチテナント) Step 1: 施設マスタ・全体管理者・ユーザーの施設所属
-- 冪等。既存データは「既定施設」に割当。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 施設マスタ
CREATE TABLE IF NOT EXISTS facilities (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    kana       VARCHAR(255) NOT NULL DEFAULT '',
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE facilities IS '施設マスタ';

-- 既定施設(既存データの割当先)。名称は現在の company_name(施設名) 設定を使用。無ければ「テスト施設」
INSERT INTO facilities (name)
SELECT COALESCE(NULLIF((SELECT value FROM app_settings WHERE key = 'company_name'), ''), 'テスト施設')
WHERE NOT EXISTS (SELECT 1 FROM facilities);

-- users: 施設所属と全体管理者(superadmin)。ログインIDはメール対応で拡幅
ALTER TABLE users ALTER COLUMN login_id TYPE VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE users ADD CONSTRAINT users_user_type_check
    CHECK (user_type IN ('superadmin', 'admin', 'general', 'supplier'));
COMMENT ON COLUMN users.facility_id IS '所属施設(全体管理者はNULL=全施設)';

-- 既存ユーザーを既定施設へ割当(全体管理者以外)
UPDATE users SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
 WHERE facility_id IS NULL AND user_type <> 'superadmin';

-- 全体管理者(初期): admin@e-soft.main.jp / super12345 (初回ログイン時に変更必須)
INSERT INTO users (user_type, name, kana, login_id, password_hash, must_change_password, facility_id)
SELECT 'superadmin', '全体管理者', 'ゼンタイカンリシャ', 'admin@e-soft.main.jp',
       crypt('super12345', gen_salt('bf', 10)), TRUE, NULL
WHERE NOT EXISTS (SELECT 1 FROM users WHERE login_id = 'admin@e-soft.main.jp');

CREATE INDEX IF NOT EXISTS idx_users_facility ON users(facility_id);
