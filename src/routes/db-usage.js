'use strict';

// データベース使用量の詳細API (全体管理者=superadmin のみ。
// server.js で requireRole('superadmin') を適用)。
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/db-usage
// DB全体のサイズと、テーブルごとのサイズ・行数(概算)を返す。
router.get('/', async (req, res) => {
  try {
    const dbSize = await pool.query(`SELECT pg_database_size(current_database()) AS bytes`);
    const tables = await pool.query(
      `SELECT c.relname AS name,
              pg_total_relation_size(c.oid) AS bytes,
              COALESCE(s.n_live_tup, 0)     AS rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC`
    );
    res.json({
      dbBytes: Number(dbSize.rows[0].bytes || 0),
      tables: tables.rows.map((r) => ({
        name: r.name,
        bytes: Number(r.bytes || 0),
        rows: Number(r.rows || 0),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('DB使用量取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
