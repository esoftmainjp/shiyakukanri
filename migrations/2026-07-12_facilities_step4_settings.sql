-- 施設別管理(マルチテナント) Step 4: 運用設定(app_settings)の施設別化
-- app_settings を (facility_id, key) 単位にする。既存の全体設定は既定施設へ割当。
-- 冪等: 既存列/制約があれば作り直さない。

-- 施設列を追加
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);

-- 既存の全体設定(facility_id IS NULL)を既定施設へ割当
UPDATE app_settings
   SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
 WHERE facility_id IS NULL;

-- 主キー(key)を撤去し、(facility_id, key) の一意制約へ差し替え
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_app_settings') THEN
    ALTER TABLE app_settings ADD CONSTRAINT uq_app_settings UNIQUE NULLS NOT DISTINCT (facility_id, key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_app_settings_facility ON app_settings(facility_id);
