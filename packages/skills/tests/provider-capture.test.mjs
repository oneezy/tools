import assert from 'node:assert/strict';
import {test} from 'node:test';
import {coverageWindow, sourceFor, fingerprint, identity, verifiedReceipt, advanceCheckpoint} from '../skills/oneezy/oneezy-brain/scripts/provider-capture.mjs';
const config = {contract_version: 1, enabled: true, initial_lookback: {email_days: 7, calendar_days: 14}, overlap_hours: 48,
  sources: [{source_key: 'work-email', provider: 'gmail', account_email: 'work@example.invalid', scope: {kind: 'mailbox', id: 'INBOX'}, enabled: true},
    {source_key: 'work-calendar', provider: 'google-calendar', account_email: 'work@example.invalid', scope: {kind: 'calendar', id: 'observed-calendar-id'}, enabled: true}]};
const envelope = {source_key: 'work-email', provider: 'gmail', account_email: 'work@example.invalid', scope_id: 'INBOX', item_id: 'observed-message-id', subject: 'Observed subject', revision: {kind: 'etag', value: 'observed-etag'}, source_url: null, source_updated: null};
const coverage = {source_key: 'work-email', through: '2026-10-08T14:00:00Z', complete: true, all_pages_read: true, failures: []};
test('Bounded email and calendar windows use initial lookback and verified 48-hour overlap', () => {
  const asOf = '2026-10-08T14:00:00Z';
  assert.equal(coverageWindow(config, 'work-email', asOf).after, '2026-10-01T14:00:00.000Z');
  const calendar = coverageWindow(config, 'work-calendar', asOf);
  assert.equal(calendar.after, '2026-09-24T14:00:00.000Z'); assert.equal(calendar.calendar_through, '2026-10-22T14:00:00.000Z');
  assert.equal(coverageWindow(config, 'work-calendar', asOf, {source_key: 'work-calendar', verified_success_through: '2026-10-07T09:00:00Z'}).calendar_from, '2026-09-24T14:00:00.000Z');
  assert.equal(coverageWindow(config, 'work-email', asOf, {source_key: 'work-email', verified_success_through: '2026-10-07T09:00:00Z'}).after, '2026-10-05T09:00:00.000Z');
});
test('Account, scope, disabled state and real revision are mandatory', () => {
  for (const extra of [{account_email: 'other@example.invalid'}, {scope_id: 'ALL'}, {revision: null}]) assert.throws(() => sourceFor(config, {...envelope, ...extra}));
  assert.throws(() => sourceFor({...config, enabled: false}, envelope), /disabled/);
  assert.throws(() => coverageWindow(config, 'work-email', '2026-10-08T14:00:00'), /timezone/);
});
test('Actual observed material provides a stable fingerprint and identity retains account/scope', () => {
  assert.deepEqual(fingerprint({subject: 'A', body: 'B'}), fingerprint({body: 'B', subject: 'A'}));
  assert.notDeepEqual(fingerprint({subject: 'A'}), fingerprint({subject: 'B'}));
  assert.throws(() => fingerprint({}));
  assert.notEqual(identity(envelope), identity({...envelope, account_email: 'other@example.invalid'}));
});
test('Receipts follow exact canonical readback; failed/changed items never advance', () => {
  const intended = {ID: 'TEST-CAPTURE', subject: envelope.subject, destination: 'Inbox', action: 'capture'};
  assert.throws(() => verifiedReceipt(config, envelope, intended, null, '2026-10-08T14:01:00Z'), /readback/);
  const receipt = verifiedReceipt(config, envelope, intended, intended, '2026-10-08T14:01:00Z');
  assert.throws(() => advanceCheckpoint(config, envelope.source_key, coverage.through, [envelope], [], coverage), /Partial/);
  assert.throws(() => advanceCheckpoint(config, envelope.source_key, coverage.through, [{...envelope, revision: {kind: 'etag', value: 'new-revision'}}], [receipt], coverage), /Partial/);
  assert.throws(() => advanceCheckpoint(config, envelope.source_key, coverage.through, [envelope], [{...receipt, destination: 'Archive'}], coverage), /Partial/);
  assert.equal(advanceCheckpoint(config, envelope.source_key, coverage.through, [envelope], [receipt], coverage).verified_success_through, coverage.through);
});
test('A failed or incomplete scoped read cannot advance even an empty batch', () => {
  for (const proof of [null, {...coverage, complete: false}, {...coverage, all_pages_read: false}, {...coverage, failures: ['read failed']}, {...coverage, source_key: 'other'}])
    assert.throws(() => advanceCheckpoint(config, 'work-email', coverage.through, [], [], proof), /coverage/);
  assert.equal(advanceCheckpoint(config, 'work-email', coverage.through, [], [], coverage).verified_success_through, coverage.through);
});
