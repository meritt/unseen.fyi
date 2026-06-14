import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const toUnsigned = (n: number): number => (n < 0 ? n + 0x1_00_00_00_00 : n);

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table.push(toUnsigned(c));
  }
  return table;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xff_ff_ff_ff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return toUnsigned(c ^ 0xff_ff_ff_ff);
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tdata = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tdata), 0);
  return Buffer.concat([len, tdata, crc]);
};

const buildIhdr = (width = 1, height = 1): Buffer => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(8, 8);
  data.writeUInt8(2, 9);
  data.writeUInt8(0, 10);
  data.writeUInt8(0, 11);
  data.writeUInt8(0, 12);
  return chunk('IHDR', data);
};

const buildIdat = (): Buffer => {
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]);
  return chunk('IDAT', deflateSync(raw));
};

const IEND = chunk('IEND', Buffer.alloc(0));

export const buildMinimalPng = (): Buffer =>
  Buffer.concat([PNG_SIGNATURE, buildIhdr(), buildIdat(), IEND]);

export const buildPaddedPng = (targetBytes: number): Buffer => {
  const sig = PNG_SIGNATURE;
  const ihdr = buildIhdr();
  const idat = buildIdat();
  const fixedSize = sig.length + ihdr.length + idat.length + IEND.length;
  const TEXT_FRAMING = 12;
  const TEXT_KEY = Buffer.from('Comment\0');
  const padNeeded = Math.max(0, targetBytes - fixedSize - TEXT_FRAMING - TEXT_KEY.length);
  const padBuf = Buffer.alloc(padNeeded, 0x61);
  const text = chunk('tEXt', Buffer.concat([TEXT_KEY, padBuf]));
  return Buffer.concat([sig, ihdr, idat, text, IEND]);
};
