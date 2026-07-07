-- 在庫移動に「対象日」を追加。返品日をユーザーが指定できるようにし、
-- 支払(請求)集計の期間フィルタ・明細日付を登録日ではなく対象日で扱う。冪等。
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS movement_date DATE;

-- 既存の返品は登録日(created_at)を対象日として埋め戻し(集計の後方互換)。
UPDATE stock_movements
   SET movement_date = created_at::date
 WHERE movement_type = 'return' AND movement_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_movement_date ON stock_movements(movement_date);

COMMENT ON COLUMN stock_movements.movement_date IS '対象日(返品日など)。NULLの場合は集計で created_at::date を用いる';
