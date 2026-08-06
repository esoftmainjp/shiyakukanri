'use strict';

// 依存ライブラリを増やさないための最小ZIP生成(無圧縮=stored方式)。
// files: [{ name: 'products.csv', data: <Buffer|string> }]
// 返り値: ZIP全体の Buffer。Excel等で解凍・閲覧できる標準ZIP。

// CRC32(標準多項式 0xEDB88320)テーブル
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const entries = files.map((f) => ({
    name: Buffer.from(f.name, 'utf8'),
    data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8'),
  }));

  const chunks = [];
  const central = [];
  let offset = 0;
  // DOSタイムスタンプは固定(再現性のため。時刻はログ側で管理)
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01

  for (const e of entries) {
    const crc = crc32(e.data);
    const nameLen = e.name.length;
    const size = e.data.length;

    // ローカルファイルヘッダ
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0x0800, 6);       // flags: bit11=UTF-8ファイル名
    lfh.writeUInt16LE(0, 8);            // method: 0=stored
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);        // compressed size
    lfh.writeUInt32LE(size, 22);        // uncompressed size
    lfh.writeUInt16LE(nameLen, 26);
    lfh.writeUInt16LE(0, 28);           // extra len
    chunks.push(lfh, e.name, e.data);

    // 中央ディレクトリヘッダ
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0x0800, 8);       // flags
    cdh.writeUInt16LE(0, 10);           // method
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameLen, 28);
    cdh.writeUInt16LE(0, 30);           // extra len
    cdh.writeUInt16LE(0, 32);           // comment len
    cdh.writeUInt16LE(0, 34);           // disk number
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // local header offset
    central.push(cdh, e.name);

    offset += lfh.length + e.name.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // 終端レコード(EOCD)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

module.exports = { buildZip, crc32 };
