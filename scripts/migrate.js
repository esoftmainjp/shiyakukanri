'use strict';

// DDL / seed を実行する簡易マイグレーションスクリプト
//   node scripts/migrate.js          … DDLのみ実行
//   node scripts/migrate.js --seed   … seedのみ実行
//   node scripts/migrate.js --all    … DDL → seed の順で実行

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const DDL_FILE = path.join(ROOT, 'ddl_postgresql.sql');
const SEED_FILE = path.join(ROOT, 'seed_data.sql');

async function runSqlFile(label, file) {
  if (!fs.existsSync(file)) {
    throw new Error(`SQLファイルが見つかりません: ${file}`);
  }
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`[${label}] 実行開始: ${path.basename(file)}`);
  await pool.query(sql);
  console.log(`[${label}] 完了`);
}

async function main() {
  const args = process.argv.slice(2);

  // 任意SQLファイルの実行: node scripts/migrate.js --file path/to.sql
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) {
    const target = args[fileIdx + 1];
    if (!target) { console.error('--file にSQLファイルのパスを指定してください'); process.exitCode = 1; await pool.end(); return; }
    try {
      await runSqlFile('MIGRATION', path.isAbsolute(target) ? target : path.join(ROOT, target));
      console.log('マイグレーションが正常に完了しました。');
    } catch (err) {
      console.error('マイグレーション失敗:', err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
    return;
  }

  const doSeed = args.includes('--seed') || args.includes('--all');
  const doDdl = args.includes('--all') || !args.includes('--seed');

  try {
    if (doDdl) await runSqlFile('DDL', DDL_FILE);
    if (doSeed) await runSqlFile('SEED', SEED_FILE);
    console.log('すべての処理が正常に完了しました。');
  } catch (err) {
    console.error('マイグレーション失敗:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
