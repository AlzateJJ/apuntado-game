import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCard, reconcileOrder } from '../apps/web/src/hand-order.js';
import { warningVolume } from '../apps/web/src/audio.js';

test('manual order survives repeated snapshots, draws, discards and duplicated saved identifiers', () => {
  let order = moveCard([1, 2, 3, 4], 1, 3);
  assert.deepEqual(order, [2, 3, 1, 4]);
  assert.deepEqual(reconcileOrder(order, [1, 2, 3, 4]), order);
  order = reconcileOrder(order, [1, 2, 3, 4, 5]);
  assert.deepEqual(order, [2, 3, 1, 4, 5]);
  order = reconcileOrder(order, [1, 2, 4, 5]);
  assert.deepEqual(order, [2, 1, 4, 5]);
  assert.deepEqual(reconcileOrder([...order, 2, 99], [1, 2, 4, 5, 6]), [2, 1, 4, 5, 6]);
});
test('clock alert volume increases each second from seven to one, with a bounded peak', () => {
  const volumes = [7, 6, 5, 4, 3, 2, 1].map(warningVolume);
  assert.ok(volumes.every((volume, i) => i === 0 || volume > volumes[i - 1]!));
  assert.ok(volumes.at(-1)! < 0.15);
});
