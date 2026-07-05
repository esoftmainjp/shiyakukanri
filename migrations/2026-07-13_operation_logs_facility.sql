-- 施設別管理: 操作ログに施設IDを持たせる
-- 目的: 全体管理者の操作も「操作した施設」のログとして残し、施設別に絞り込めるようにする。
-- 冪等: 既存列があれば追加しない。既存ログはユーザーの所属施設で補完する。

ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS facility_id BIGINT REFERENCES facilities(id);

-- 既存ログを、記録したユーザーの所属施設で補完(全体管理者=施設なしはNULLのまま)
UPDATE operation_logs ol
   SET facility_id = (SELECT u.facility_id FROM users u WHERE u.id = ol.user_id)
 WHERE ol.facility_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_operation_logs_facility ON operation_logs(facility_id);
