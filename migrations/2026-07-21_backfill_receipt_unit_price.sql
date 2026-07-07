-- 入庫明細の単価が0/未設定のものを、紐づく商品詳細マスターの単価で埋め戻す。
-- (従来は入庫画面に単価入力が無く0で保存されていたため、返品既定・支払集計が0になっていた)
-- product_detail_id が一致する明細のみ対象。マスター単価>0 のときだけ更新。冪等。
UPDATE receipt_details rd
   SET unit_price = pd.unit_price
  FROM product_details pd
 WHERE rd.product_detail_id = pd.id
   AND (rd.unit_price = 0 OR rd.unit_price IS NULL)
   AND pd.unit_price > 0;
