const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRemoteFileContents, parseRemoteModifiedTime } = require('../dist-electron/sync.js');

test('decodes WebDAV string, Buffer, Uint8Array, and data wrappers', () => {
  assert.equal(decodeRemoteFileContents('你好'), '你好');
  assert.equal(decodeRemoteFileContents(Buffer.from('buffer')), 'buffer');
  assert.equal(decodeRemoteFileContents(new Uint8Array(Buffer.from('bytes'))), 'bytes');
  assert.equal(decodeRemoteFileContents({ data: Buffer.from('wrapped') }), 'wrapped');
});

test('rejects an unknown WebDAV response instead of corrupting a file', () => {
  assert.throws(() => decodeRemoteFileContents({}), /无法识别/);
});

test('parses supported remote modified-time fields and wrappers', () => {
  const expected = Date.parse('2026-09-27T10:20:00.000Z');
  assert.equal(parseRemoteModifiedTime({ lastmod: '2026-09-27T10:20:00.000Z' }), expected);
  assert.equal(parseRemoteModifiedTime({ data: { lastModified: '2026-09-27T10:20:00.000Z' } }), expected);
  assert.equal(parseRemoteModifiedTime({ mtime: expected }), expected);
});

test('returns null for missing or invalid remote time to prevent overwrite', () => {
  assert.equal(parseRemoteModifiedTime({}), null);
  assert.equal(parseRemoteModifiedTime({ lastmod: 'not-a-date' }), null);
});
