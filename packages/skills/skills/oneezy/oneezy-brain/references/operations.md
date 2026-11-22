# Brain operations

## Save and recover

Read live headers, List, Schema and both ID columns. Normalize omitted empty cells and trailing rows only within the exact requested, verified grid bounds. IDs are immutable strings, not row numbers. Reserve historical IDs. Match provider/account/source-item ID and meaning before capture; retries retain their ID and Doc.

For the ongoing skills, plugins and AI-tools collection, reuse the existing context Doc `1kXhbxXlFayp0Qjd3y9uSdvf_LIlVDRQQL1U3lYIcALQ` and its collection heading `h.o87g7bj48jxg`. Recheck existing deferred-skills ID `57` and routing-fix ID `58` across Inbox and Backlog by immutable ID; their historical row numbers are not write targets. Retain the collection Doc link on its matched record, and ID 58's verified parent relationship to ID 30. These corrections already exist: preserve them, with one writable location each, rather than create a replacement Doc or duplicate task system. Resolve live fields and current user edits before any change.

Map by header. Unsupported estimates, energy, dates and ownership remain blank with an Unknown/not-applicable note. Use literal native dates and the workbook timezone; change date_modified only on a real edit. Preserve source dates in source_updated and dated context. Promotion retains creation time. Creator, assigner and owner are different roles. Generated comments never masquerade as Justin.

Serialize agent writers; reread targets and compare the full row to the planned before-image immediately before writing. Refuse a changed input. Sheets has no revision CAS, so a human can still race the batch; verify and reconcile discrepancies. Updates change only named fields.

Before calling `scripts/drive-plan.mjs`, build each table from the observed native grid: `sheetId`, ordered `headers`, `headerCells`, bounded `rows: [{rowIndex,cells}]`, and `editableFields` from the live Schema. Indices are zero-based; worksheet row 1000 is rowIndex 999. Supply observed `formulaOwnedFields` and `formulaRanges` (native GridRanges) for calculated columns and spill areas, including formulas above the data window. Missing or ambiguous Schema ownership blocks writes. A formula in a header, target cell or spill range remains read-only even when Schema calls the field editable.

The planner emits one-cell `updateCells` requests with `fields: userEnteredValue`, combined in one native batch. Capture writes only supplied editable fields; update writes only named fields; moves and recovery clear only editable cells. Preserve formula anchors, calculated/spill cells, validation and formatting. Never submit a full-row value payload or change formulas to make capture succeed. If a computed field is blank/unknown, omit it from the payload.

An authorized temporary fixture has an exact private owned-cell receipt: `{tab,rowIndex,fields:{ID,title,...}}`. Cleanup requires its TEST- ID, [TEST] title, matching entered values and no other entered human data. Clear only those named editable cells through `remove-test`; later edits or a changed formula guard block cleanup. Do not use a label alone as ownership evidence.

For explicit selection, save a private recovery receipt containing the original Inbox row and intended Backlog result. One Sheets batch writes Backlog with the same ID and clears only Inbox userEnteredValue, preserving format/validation. Read both locations: exactly one match must remain. Retrying an already promoted ID does nothing. Recover only if the receipt matches, the original Inbox slot is empty, and every entered Backlog cell still matches the promoted result. Header-array outputs may recalculate; later entered formulas count as edits. Never overwrite later edits.

If both locations contain the ID, stop normal operations. A native batch is atomic, so two copies indicate a legacy/intervening write, not a completed promotion. Reconcile the receipt and current row contents explicitly; retain human changes. Do not blindly clear either copy or allocate a replacement ID.

Context edits use native Docs requiredRevisionId and preserve smart controls. One subject has one authority with dated sources and superseded decisions. Read back the changed passage. Rename/move the same Doc in place. Archive/discard follows Justin's disposition; completion is not archival.

## Agenda

Read Backlog and current time in its timezone. Exclude archived and Done/Complete. Do now: evidenced past-due/next-three-day deadlines and Critical priority. Coming up: next-two-week dates and High priority. Waiting on others: GTD Waiting for. Cap each at five. Unknown dates are not overdue. Exclude Waiting/Someday from ready recommendations; show verified unmet prerequisite IDs without inventing edges. Finish with Inbox count, ingestion coverage/as-of and at most two sentences on the next choice. Captured ideas are not approved tasks.

## Project publication

Filter exact project_id, client_visible TRUE and not archived. Publish only ID, client_title, project, type, status, approved priority/estimate/dates/phase, record_kind and client_summary. Exclude internal details, owners, source mail links, memory, private references and other projects. Never place IMPORTRANGE to private Brain in a client file or grant import access. Preserve local Board/Roadmap formulas. Verify published IDs and a private-record exclusion. Sharing is unchanged.
