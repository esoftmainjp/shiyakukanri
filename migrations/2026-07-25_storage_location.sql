-- 商品マスターに保管場所/棚番を追加。冪等・非破壊(既存行は空文字)。
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_location VARCHAR(255) NOT NULL DEFAULT '';
COMMENT ON COLUMN products.storage_location IS '保管場所/棚番';
