import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeBranch, permissionDiff, permittedHeads, startPermissions } from '../src/pages/Admin/utils/permissions.ts';
import { applyHeadChanges } from '../src/pages/Admin/utils/headTree.ts';
import type { Head } from '../src/pages/Admin/types.ts';

const heads: Head[] = [
  { head_id: 1, parent_head_id: null, head_name: 'Parent', is_active: true, is_transactionable: false },
  { head_id: 2, parent_head_id: 1, head_name: 'Child', is_active: true, is_transactionable: true },
  { head_id: 3, parent_head_id: null, head_name: 'Other', is_active: true, is_transactionable: true },
];

test('a child grant stays isolated while parent grants inherit through the branch', () => {
  assert.deepEqual(permittedHeads(heads, [2]).map((head) => head.head_id), [2]);
  assert.deepEqual(permittedHeads(heads, [1]).map((head) => head.head_id), [1, 2]);
  assert.deepEqual(permittedHeads([{ ...heads[1], is_active: false }], [2]), []);
});

test('moving an assigned head changes neither its assignment nor visibility', () => {
  const assigned = [2];
  const moved = applyHeadChanges(heads, [{ op: 'move', head_id: 2, new_parent_id: 3 }]);
  assert.deepEqual(permittedHeads(moved, assigned).map((head) => head.head_id), [2]);
  assert.deepEqual(assigned, [2]);
});

test('merging never transfers source permissions to the target', () => {
  const assigned = [2];
  const merged = applyHeadChanges(heads, [{ op: 'merge', source_head_id: 2, target_head_id: 3 }]);
  assert.deepEqual(permittedHeads(merged, assigned), []);
  assert.deepEqual(assigned, [2]);
});

test('branch decisions produce independent snapshots suitable for undo without modifying earlier rules', () => {
  const initial = startPermissions([1, 1]);
  const deniedChild = changeBranch(initial.history[0], heads, 2, false);
  const allowedAgain = changeBranch(deniedChild, heads, 2, true);
  assert.deepEqual(deniedChild, [1, -2]);
  assert.deepEqual(permittedHeads(heads, deniedChild).map((head) => head.head_id), [1]);
  assert.deepEqual(allowedAgain, [1, 2]);
  assert.deepEqual(permittedHeads(heads, initial.history[0]).map((head) => head.head_id), [1, 2]);
  assert.deepEqual(initial.history, [[1]]);
});

test('separate users retain independent decisions and signed permission diffs', () => {
  const aliceInitial = startPermissions([]);
  const bobInitial = startPermissions([3]);
  const alice = changeBranch(aliceInitial.history[0], heads, 2, true);
  const bob = changeBranch(bobInitial.history[0], heads, 1, false);
  assert.deepEqual(alice, [2]);
  assert.deepEqual(bob, [3, -1]);
  assert.deepEqual(aliceInitial.history, [[]]);
  assert.deepEqual(bobInitial.history, [[3]]);
  assert.deepEqual(permissionDiff([1, 2], [1, -2]), { granted: [-2], revoked: [2] });
  assert.deepEqual(permissionDiff([1, 2], [2, 3]), { granted: [3], revoked: [1] });
});

test('the nearest grant or denial determines descendant permissions', () => {
  const tree = [...heads, { ...heads[1], head_id: 4, parent_head_id: 2, head_name: 'Grandchild' }];
  assert.deepEqual(permittedHeads(tree, [1, -2]).map((head) => head.head_id), [1]);
  assert.deepEqual(permittedHeads(tree, [-1, 2]).map((head) => head.head_id), [2, 4]);
  assert.deepEqual(permittedHeads(tree, [1, -2, 4]).map((head) => head.head_id), [1, 4]);
});

test('changing an entire branch removes conflicting descendant rules and preserves unrelated branches', () => {
  const tree = [...heads, { ...heads[1], head_id: 4, parent_head_id: 2, head_name: 'Grandchild' }];
  const before = [1, -2, 4, 3];
  assert.deepEqual(changeBranch(before, tree, 1, false), [3, -1]);
  assert.deepEqual(changeBranch(before, tree, 1, true), [3, 1]);
  assert.deepEqual(before, [1, -2, 4, 3]);
});

test('moving a branch changes inherited access but preserves explicit grants', () => {
  const moved = applyHeadChanges(heads, [{ op: 'move', head_id: 2, new_parent_id: 3 }]);
  assert.deepEqual(permittedHeads(moved, [1]).map((head) => head.head_id), [1]);
  assert.deepEqual(permittedHeads(moved, [1, 2]).map((head) => head.head_id), [1, 2]);
  assert.deepEqual(permittedHeads(moved, [3]).map((head) => head.head_id), [2, 3]);
});

test('unassigned cyclic or orphaned ancestry cannot accidentally grant access', () => {
  const malformed = [{ ...heads[0], parent_head_id: 2 }, { ...heads[1], parent_head_id: 1 }, { ...heads[2], parent_head_id: 999 }];
  assert.deepEqual(permittedHeads(malformed, []), []);
  assert.deepEqual(permittedHeads(malformed, [3]).map((head) => head.head_id), [3]);
});
