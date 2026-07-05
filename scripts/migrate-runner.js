'use strict';

// 追跡型マイグレーションランナー
//   migrations/ 内の *.sql を名前順に確認し、未適用のものだけを順に適用する。
//   適用済みは schema_migrations テーブルに記録し、次回以降はスキップする。
//   すべてのマイグレーションは冪等(IF NOT EXISTS 等)に書かれている前提のため、
//   万一 DB が遅れていても未記録分を流し直すことで自己修復できる。
//
//   本番(Render)では自動実行しない。ローカル(.env の AUTO_MIGRATE=1)でのみ使う。

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// pool: pg Pool。log: 進捗ロガー(既定は無出力)。
// 戻り値: { applied: [適用したファイル名...], pending: 残数 }
async function syncMigrations(pool, log = () => {}) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    let files = [];
    try {
      files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    } catch (e) {
      return { applied: [], pending: 0 };
    }

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const done = new Set(rows.map((r) => r.filename));
    const pending = files.filter((f) => !done.has(f));

    const applied = [];
    for (const f of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`[migrate] 適用: ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`マイグレーション失敗 (${f}): ${err.message}`);
      }
    }
    return { applied, pending: pending.length };
  } finally {
    client.release();
  }
}

module.exports = { syncMigrations };
