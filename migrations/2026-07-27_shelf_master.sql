-- 保管場所(自由入力 storage_location)を廃止し、棚マスター(shelves)を新設。
-- 商品は棚を参照(products.shelf_id)。既存データは各施設に「棚１」を作成し全商品へ割当てる。
-- 冪等。非破壊(storage_location はデータ未運用のため削除)。

-- 1) 棚マスター(施設別。他マスタと同様の構成)
CREATE TABLE IF NOT EXISTS shelves (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    kana        VARCHAR(255) NOT NULL DEFAULT '',
    note        TEXT         NOT NULL DEFAULT '',
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    facility_id BIGINT       REFERENCES facilities(id)
);
CREATE INDEX IF NOT EXISTS idx_shelves_facility ON shelves(facility_id);

-- 2) 商品に棚参照を追加(まずは NULL 許容。後で全商品へ割当てる)
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_id BIGINT REFERENCES shelves(id);

-- 3) 商品が存在する施設ごとに「棚１」を作成(無ければ)。facility_id NULL の旧データにも対応。
INSERT INTO shelves (name, kana, facility_id)
SELECT DISTINCT '棚１', '', p.facility_id
  FROM products p
 WHERE NOT EXISTS (
   SELECT 1 FROM shelves s
    WHERE s.name = '棚１' AND s.facility_id IS NOT DISTINCT FROM p.facility_id
 );

-- 4) 全商品に自施設の「棚１」を割当て(未設定のもの)
UPDATE products p
   SET shelf_id = s.id
  FROM shelves s
 WHERE s.name = '棚１'
   AND s.facility_id IS NOT DISTINCT FROM p.facility_id
   AND p.shelf_id IS NULL;

-- 5) 旧・保管場所カラムを削除
ALTER TABLE products DROP COLUMN IF EXISTS storage_location;
