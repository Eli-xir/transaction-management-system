import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAttachment } from '../src/data/prepareAttachment.ts';

test('upload copy preserves receipt bytes and metadata and no longer reads the source', async () => {
  const bytes = new Uint8Array([255, 216, 255, 0, 42, 128]);
  const original = new File([bytes], 'receipt.jpg', { type: 'image/jpeg', lastModified: 123 });
  const copy = await prepareAttachment(original);
  Object.defineProperty(original, 'arrayBuffer', { value: () => { throw new Error('Provider is gone'); } });
  assert.notEqual(copy, original);
  assert.equal(copy.name, original.name);
  assert.equal(copy.type, original.type);
  assert.equal(copy.lastModified, original.lastModified);
  assert.deepEqual(new Uint8Array(await copy.arrayBuffer()), bytes);
});

test('unreadable gallery file reports a device read failure with its original cause', async () => {
  const file = new File(['receipt'], 'receipt.jpg');
  const cause = new DOMException('Provider cannot read file', 'NotReadableError');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { throw cause; } });
  await assert.rejects(prepareAttachment(file), (error: Error) => {
    assert.match(error.message, /Could not read this file from your device/);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('empty or oversized files are rejected before accessing contents', async () => {
  for (const file of [new File([], 'empty.jpg'), new File(['1234'], 'large.jpg')]) {
    Object.defineProperty(file, 'arrayBuffer', { value: () => assert.fail('Must not read invalid size') });
    await assert.rejects(prepareAttachment(file, 3), /up to 5 MB/);
  }
});

test('incomplete reads are rejected instead of uploading a truncated receipt', async () => {
  const file = new File(['receipt'], 'receipt.jpg');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(2) });
  await assert.rejects(prepareAttachment(file), /could not be read completely/);
});
