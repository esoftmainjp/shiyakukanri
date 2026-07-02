'use strict';

require('dotenv').config();
const { Pool, types } = require('pg');

// DATE型(OID 1082)を JS Date に変換せず 'YYYY-MM-DD' の文字列のまま返す。
// これによりタイムゾーンによる日付ズレを防ぐ。
types.setTypeParser(1082, (val) => val);

// PGSSL=true もしくは本番環境ではSSLを有効化する (Renderのマネージドpostgres向け)
const useSsl =
  String(process.env.PGSSL).toLowerCase() === 'true' ||
  process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('予期しないDBプールエラー:', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  // トランザクション用にクライアントを取得する
  getClient: () => pool.connect(),
};
