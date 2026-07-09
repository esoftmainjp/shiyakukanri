-- 支払失敗(past_due)からの猶予期間管理。冪等。
-- ・facilities.past_due_since: past_due になった時刻(猶予起点)
-- ・system_settings.payment_grace_days: 猶予日数(既定14。0で自動停止しない)
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ;
COMMENT ON COLUMN facilities.past_due_since IS '支払失敗(past_due)になった時刻。猶予超過の判定に使用';

INSERT INTO system_settings (key, value) VALUES ('payment_grace_days', '14')
ON CONFLICT (key) DO NOTHING;
