import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userContacts, validateProfile } from '../src/pages/Admin/utils/userProfile.ts';

test('legacy contact fields migrate and explicit empty contacts stay empty', () => {
  const user = { user_id: 'a', user_name: 'Ali', is_active: true, contact_no: '0300' };
  assert.deepEqual(userContacts(user), ['0300']);
  assert.deepEqual(userContacts({ ...user, contacts: [] }), []);
});

test('multiple contacts are trimmed, empty rows removed, and duplicates rejected', () => {
  assert.deepEqual(validateProfile({ user_name: ' Ali ', contacts: [' 0300 ', '', '+92 311'] }), {
    user_name: 'Ali', contacts: ['0300', '+92 311'], description: '',
  });
  assert.throws(() => validateProfile({ user_name: 'Ali', contacts: ['0300', ' 0300 '] }), /once/);
  assert.throws(() => validateProfile({ user_name: ' ', contacts: [] }), /name/);
  assert.throws(() => validateProfile({ user_name: 'Ali', contacts: ['1'.repeat(25)] }), /24/);
});

test('profile descriptions are trimmed and preserved in the API input', () => {
  assert.deepEqual(validateProfile({ user_name: ' Ali ', contacts: [], description: '  Tile fixer  ' }), {
    user_name: 'Ali', contacts: [], description: 'Tile fixer',
  });
});
