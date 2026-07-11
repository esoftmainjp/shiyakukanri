-- 開封後有効日数(開封=出庫からの使用可能日数)。0=無効(未設定)。冪等・非破壊。
-- 開封中アイテムの実効期限 = min(ラベル使用期限, 使用開始日 + open_life_days) の判定に使う。
ALTER TABLE product_details ADD COLUMN IF NOT EXISTS open_life_days INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN product_details.open_life_days IS '開封後有効日数(0=無効。開封日=使用開始日からの使用可能日数)';
