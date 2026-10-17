import assert from 'node:assert/strict';
import {lookup, plan, publishable, records} from '../skills/oneezy/oneezy-brain/scripts/drive-plan.mjs';

const headers = ['ID', 'title', 'collection', 'views', 'status', 'priority_developer', 'energy',
  'date_created', 'date_modified', 'date_due', 'date_start', 'context_doc', 'details',
  'dependencies_before', 'gtd', 'source_url', 'source_provider', 'source_account',
  'source_item_id', 'project_id', 'project', 'client_visible', 'client_title',
  'client_summary', 'archived', 'type', 'estimation', 'phase', 'record_kind', 'user_owned'];
const native = value => value === '' || value == null ? {} : {userEnteredValue: {
  [typeof value === 'boolean' ? 'boolValue' : typeof value === 'number' ? 'numberValue' : 'stringValue']: value,
}};
const table = (sheetId, data) => ({sheetId, headers, editableFields: [...headers], rows: Array.from({length: 12}, (_, i) => ({
  rowIndex: i + 1, cells: headers.map(key => native(data[i]?.[key])),
}))});
const state = (inbox = [], backlog = []) => ({
  statuses: ['Todo', 'Doing', 'Blocked', 'On hold', 'Review', 'Done', 'Complete'],
  energy: ['Low', 'Medium', 'High'], priorities: ['Critical', 'High', 'Medium', 'Low'],
  tables: {Inbox: table(101, inbox), Backlog: table(102, backlog)},
});
function apply(snapshot, requests) {
  for (const {updateCells: update} of requests) {
    const target = Object.values(snapshot.tables).find(t => t.sheetId === update.start.sheetId);
    const row = target.rows.find(r => r.rowIndex === update.start.rowIndex);
    update.rows[0].values.forEach((cell, offset) => { row.cells[update.start.columnIndex + offset] = structuredClone(cell); });
  }
}
const idea = {
  ID: 'B-001', title: 'Maybe make a weekly learning sketchbook', collection: 'personal',
  views: 'Inbox', status: '', priority_developer: '', energy: '', date_due: '', estimation: '',
  date_created: '2026-10-07T08:30:00Z', date_modified: '2026-10-07T08:30:00Z',
  context_doc: 'https://docs.example.invalid/document/d/context-B-001',
  details: 'Tentative idea. Priority, energy, estimate, owner and deadline are unknown.',
  source_url: '', user_owned: '',
};
const results = [];
const run = (name, fn) => {
  try { const detail = fn(); results.push({name, pass: true, detail}); }
  catch (error) { results.push({name, pass: false, observed: error.message}); }
};

run('Fixture cleanup clears only receipt-owned cells and refuses later human edits', () => {
  const data = {ID: 'TEST-OWNED', title: '[TEST] temporary', details: 'Observed fixture'};
  const s = state([data]), receipt = {tab: 'Inbox', rowIndex: 1, fields: data};
  assert.throws(() => plan(s, {kind: 'remove-test', id: data.ID}), /receipt/);
  const cleanup = plan(s, {kind: 'remove-test', id: data.ID, receipt});
  assert.equal(cleanup.requests.length, 3);
  s.tables.Inbox.rows[0].cells[headers.indexOf('context_doc')] = native('HUMAN EDIT');
  assert.throws(() => plan(s, {kind: 'remove-test', id: data.ID, receipt}), /unowned edit/);
  s.tables.Inbox.rows[0].cells[headers.indexOf('context_doc')] = {};
  s.tables.Inbox.rows[0].cells[headers.indexOf('details')] = native('changed');
  assert.throws(() => plan(s, {kind: 'remove-test', id: data.ID, receipt}), /changed/);
});
run('Tentative capture stays Inbox with one stable ID and unknown values blank', () => {
  const s = state(); const p = plan(s, {kind: 'capture', data: idea}); apply(s, p.requests);
  assert.equal(lookup(s, 'B-001').tab, 'Inbox'); assert.equal(records(s.tables.Backlog).length, 0);
  for (const key of ['priority_developer', 'energy', 'date_due', 'estimation', 'user_owned']) assert.equal(lookup(s, 'B-001').data[key], '');
  assert.equal(lookup(s, 'B-001').data.context_doc, idea.context_doc);
  assert.match(lookup(s, 'B-001').data.details, /unknown/);
  return 'One Inbox write; no selection or task execution.';
});
run('Exact-ID lookup distinguishes similar IDs across both tabs', () => {
  const s = state([idea], [{...idea, ID: 'B-0010', views: 'Backlog'}]);
  assert.equal(lookup(s, 'B-001').tab, 'Inbox'); assert.equal(lookup(s, 'B-0010').tab, 'Backlog');
  assert.equal(lookup(s, 'B-01'), null); return 'String equality, no title or prefix substitution.';
});
run('Same subject and empty URL across provider accounts remain distinct captures', () => {
  const first = {...idea, source_provider: 'gmail', source_account: 'one@example.invalid', source_item_id: 'item-one'};
  const second = {...first, ID: 'B-002', source_account: 'two@example.invalid', source_item_id: 'item-two'};
  const s = state([first]);
  assert.throws(() => plan(s, {kind: 'capture', data: {...second, ID: first.ID}}), /different material/);
  const capture = plan(s, {kind: 'capture', data: second});
  assert.equal(capture.result, 'captured'); apply(s, capture.requests);
  assert.equal(records(s.tables.Inbox).length, 2);
  assert.equal(plan(s, {kind: 'capture', data: {...second, ID: 'B-003'}}).id, second.ID);
});
run('Exact-ID lookup still works when live headers put ID after a blank column', () => {
  const s = state(); s.tables.Inbox.headers = ['collection', 'ID', 'title'];
  s.tables.Inbox.rows[0].cells = ['', 'B-HEADER', 'Header order test'].map(native);
  assert.ok(lookup(s, 'B-HEADER'), 'Valid ID row was filtered out because the first cell is blank.');
});
run('Promotion requires explicit selection and retains identity/context/creation', () => {
  const s = state([idea]); assert.throws(() => plan(s, {kind: 'promote', id: 'B-001'}), /explicit selection/);
  const p = plan(s, {kind: 'promote', id: 'B-001', selected: true, data: {status: 'Todo'}}); apply(s, p.requests);
  const hit = lookup(s, 'B-001'); assert.equal(hit.tab, 'Backlog'); assert.equal(hit.data.date_created, idea.date_created);
  assert.equal(hit.data.context_doc, idea.context_doc); assert.equal(records(s.tables.Inbox).length, 0);
  return 'One native-style batch, same ID and linked context.';
});
run('Retry after completed promotion is idempotent', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests);
  const retry = plan(s, {kind: 'promote', id: 'B-001', selected: true}); assert.deepEqual(retry.requests, []);
  return retry.result;
});
run('A fault-injected duplicate-copy promotion stops for explicit reconciliation', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests.slice(0, 1));
  assert.throws(() => plan(s, {kind: 'promote', id: 'B-001', selected: true}), /occurs more than once; reconcile/);
  assert.throws(() => plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery}), /occurs more than once; reconcile/);
  assert.equal(records(s.tables.Inbox).length, 1); assert.equal(records(s.tables.Backlog).length, 1);
  return 'Both copies retained. Current operations guidance correctly identifies native batch atomicity and explicit receipt/content reconciliation.';
});
run('Unedited promotion can be recovered to its original Inbox slot', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests);
  const recovery = plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery}); apply(s, recovery.requests);
  assert.equal(lookup(s, 'B-001').tab, 'Inbox'); assert.equal(lookup(s, 'B-001').data.details, idea.details);
  return 'Original row restored; Backlog cleared.';
});
run('Recovery refuses a later human Backlog edit even if modified time is unchanged', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests);
  const row = s.tables.Backlog.rows.find(r => r.rowIndex === lookup(s, 'B-001').rowIndex);
  row.cells[headers.indexOf('details')] = native('HUMAN EDIT: keep this decision in Backlog.');
  let refused = false;
  try {
    const recovery = plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery, expect_modified: idea.date_modified});
    apply(s, recovery.requests);
  } catch { refused = true; }
  assert.ok(refused, 'Recovery accepted and erased HUMAN EDIT, because the receipt lacks/does not compare the intended promoted row.');
});
run('Recovery refuses original Inbox slot containing human text with its ID cell empty', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests);
  const row = s.tables.Inbox.rows.find(r => r.rowIndex === p.recovery.rowIndex);
  row.cells[headers.indexOf('details')] = native('HUMAN TEXT: unfinished new capture.');
  assert.throws(() => plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery}), /Recovery slot is occupied/);
  return 'ID-empty alone is insufficient; preserves the partial human row.';
});
run('Unknown energy sentinel is rejected; caller must use blank plus a note', () => {
  assert.throws(() => plan(state(), {kind: 'capture', data: {...idea, energy: 'Unknown'}}), /Energy is outside live List/);
  return 'Blank energy capture passed; invalid energy enum rejected.';
});
run('Unsupported priority sentinel is rejected against the synthetic live List', () => {
  assert.throws(() => plan(state(), {kind: 'capture', data: {...idea, priority_developer: 'Unknown'}}), /Priority/);
});
run('Publication includes only approved visible Trident rows and allowed values', () => {
  const publicRow = {...idea, ID: 'PUB-1', views: 'Backlog', project_id: 'project-trident', project: 'Trident',
    client_visible: true, client_title: 'Approved client title', client_summary: 'Approved summary',
    details: 'PRIVATE-DETAILS', source_url: 'PRIVATE-MAIL-LINK', context_doc: 'PRIVATE-CONTEXT',
    user_owned: 'PRIVATE-OWNER', status: 'Todo', archived: false, priority_developer: 'High'};
  const s = state([], [publicRow, {...publicRow, ID: 'PRIVATE-1', client_visible: false},
    {...publicRow, ID: 'OTHER-1', project_id: 'other-project'}, {...publicRow, ID: 'ARCHIVE-1', archived: true}]);
  const published = publishable(s, 'project-trident'); assert.deepEqual(published.map(row => row.ID), ['PUB-1']);
  assert.equal(published[0].title, 'Approved client title'); assert.equal(published[0].details_summary, 'Approved summary');
  assert.doesNotMatch(JSON.stringify(published), /PRIVATE-DETAILS|PRIVATE-MAIL-LINK|PRIVATE-CONTEXT|PRIVATE-OWNER/);
  return 'Exact project and native TRUE filters; private/archived/other-project rows excluded; no private value leaked.';
});

run('Schema masks and formula spills survive capture, promotion, recovery and clearing', () => {
  const s = state();
  const column = headers.indexOf('estimation');
  for (const table of [s.tables.Inbox, s.tables.Backlog]) {
    table.editableFields = headers.filter(key => key !== 'estimation');
    table.headerCells = headers.map(() => ({}));
    table.headerCells[column] = {userEnteredValue: {formulaValue: '=ARRAYFORMULA(1)'}};
    for (const row of table.rows) row.cells[column] = {effectiveValue: {numberValue: 1}};
  }
  const formulaBefore = structuredClone(s.tables.Backlog.headerCells[column]);
  const data = {...idea}; delete data.estimation;
  const capture = plan(s, {kind: 'capture', data});
  assert.ok(capture.requests.every(request => request.updateCells.rows[0].values.length === 1 && request.updateCells.start.columnIndex !== column));
  apply(s, capture.requests);
  assert.throws(() => plan(s, {kind: 'update', id: idea.ID, data: {estimation: 2}}), /read-only/);
  const promotion = plan(s, {kind: 'promote', id: idea.ID, selected: true}); apply(s, promotion.requests);
  apply(s, plan(s, {kind: 'recover', id: idea.ID, recovery: promotion.recovery}).requests);
  assert.equal(lookup(s, idea.ID).tab, 'Inbox');
  assert.deepEqual(s.tables.Backlog.headerCells[column], formulaBefore);
  assert.equal(s.tables.Backlog.rows[0].cells[column].effectiveValue.numberValue, 1);
});
run('A named-cell update preserves unrelated editable data and refuses a live formula or spill range', () => {
  const s = state([idea]);
  const row = s.tables.Inbox.rows[0], column = headers.indexOf('details');
  const original = structuredClone(row.cells);
  apply(s, plan(s, {kind: 'update', id: idea.ID, data: {title: 'Updated title'}}).requests);
  for (let index = 0; index < headers.length; index++) if (headers[index] !== 'title') assert.deepEqual(row.cells[index], original[index]);
  row.cells[column] = {userEnteredValue: {formulaValue: '=1'}, effectiveValue: {numberValue: 1}};
  assert.throws(() => plan(s, {kind: 'update', id: idea.ID, data: {details: 'Overwrite'}}), /Formula-owned/);
  row.cells[column] = {};
  s.tables.Inbox.formulaRanges = [{startRowIndex: 1, endRowIndex: 5, startColumnIndex: column, endColumnIndex: column + 1}];
  assert.throws(() => plan(s, {kind: 'update', id: idea.ID, data: {details: ''}}), /Formula-owned/);
  delete s.tables.Inbox.editableFields;
  assert.throws(() => plan(s, {kind: 'update', id: idea.ID, data: {title: 'No schema'}}), /Schema/);
});

// Manual forward agenda scenario: consume this synthetic snapshot by the current
run('Recovery accepts recalculated header-array output but refuses an entered formula', () => {
  const s = state([idea]); const p = plan(s, {kind: 'promote', id: 'B-001', selected: true}); apply(s, p.requests);
  const row = s.tables.Backlog.rows.find(r => r.rowIndex === lookup(s, 'B-001').rowIndex);
  const i = headers.indexOf('estimation');
  row.cells[i] = {effectiveValue: {numberValue: 0}};
  assert.ok(plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery}));
  row.cells[i] = {userEnteredValue: {formulaValue: '=1+1'}, effectiveValue: {numberValue: 2}};
  assert.throws(() => plan(s, {kind: 'recover', id: 'B-001', recovery: p.recovery}), /Backlog changed/);
});

// SKILL.md -> operations.md -> oneezy-status Brain-mode instructions. This is not
// a second implementation of the ranking rules or a native transport test.
const agendaFixture = {
  asOf: '2026-10-07T09:00:00Z', timezone: 'UTC', inboxCount: 2,
  sourceCoverage: {calendar: 'read through 2026-10-07T09:00:00Z', email: 'auth gap; verified only through 2026-10-07T07:00:00Z', github: 'disabled'},
  backlog: [
    {ID: 'A-OVER', title: 'Send an already approved draft', status: 'Todo', date_due: '2026-10-06'},
    {ID: 'A-SOON', title: 'Review the design', status: 'Todo', date_due: '2026-10-09', dependencies_before: 'A-PRE'},
    {ID: 'A-CRIT', title: 'Fix confirmed critical defect', status: 'Todo', priority_developer: 'Critical'},
    {ID: 'A-HIGH', title: 'Prepare the research outline', status: 'Todo', priority_developer: 'High'},
    {ID: 'A-LATER', title: 'Plan next week', status: 'Todo', date_due: '2026-10-17'},
    {ID: 'A-WAIT', title: 'Await partner response', status: 'Todo', gtd_process: 'Waiting for', date_due: '2026-10-05', priority_developer: 'Critical'},
    {ID: 'A-SOME', title: 'Someday idea', status: 'Todo', gtd_process: 'Someday', priority_developer: 'Critical'},
    {ID: 'A-UNKNOWN', title: 'Unknown deadline and priority', status: 'Todo', date_due: '', priority_developer: ''},
    {ID: 'A-DONE', title: 'Previously finished', status: 'Done', date_due: '2026-10-01', priority_developer: 'Critical'},
    {ID: 'A-ARCH', title: 'Archived task', status: 'Todo', archived: true, date_due: '2026-10-01'},
    {ID: 'A-PRE', title: 'Verified prerequisite still in progress', status: 'Doing'},
  ],
  manuallyObservedAgenda: {
    doNow: ['A-OVER', 'A-SOON (unmet prerequisite A-PRE)', 'A-CRIT'],
    comingUp: ['A-HIGH', 'A-LATER'], waitingOnOthers: ['A-WAIT'],
    excludedFromReady: ['A-SOME', 'A-WAIT'], excludedDoneArchived: ['A-DONE', 'A-ARCH'],
    unknownIsNotOverdue: ['A-UNKNOWN'], nextChoice: 'Choose A-OVER; it is overdue and has no evidenced unmet prerequisite.',
    ending: 'Inbox: 2 tentative captures. As of 09:00 UTC; calendar current, email coverage gap after 07:00 UTC, GitHub disabled.',
    writesAndSchedules: 'None',
  },
};
console.log(JSON.stringify({scope: 'Synthetic offline planning only; no transport, installation or schedule execution.',
  passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results, agendaFixture}, null, 2));

if(results.some(r=>!r.pass)) process.exitCode=1;
