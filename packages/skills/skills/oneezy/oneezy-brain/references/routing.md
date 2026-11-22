## Choose the operation

Capture meaningful requests and work as a visible Inbox record, including explicit captures and durable context collected during a task. Ignore conversational filler. Match against Inbox and Backlog first; update the existing subject rather than allocate a duplicate ID. A context Doc supports and is linked from that record; Doc-only storage is not a completed capture. Execution and capture have separate approval gates.

| Request | Operation |
| --- | --- |
| Remember, capture, note to self | Match source identity and meaning; update a matched Inbox subject or capture a new stable ID |
| What do we need to do, agenda | Read Backlog; render the agenda in `references/operations.md` |
| Pull up ID, find a subject | Exact-ID lookup across both tabs, or search meaning; load the owning context Doc |
| Select this | Explicit same-ID promotion; the item leaves Inbox |
| Done, status, move, rename | Update the exact authoritative record and modified time |
| Keep as knowledge, memory or reference | Match or capture a visible Inbox subject, then update and link its canonical Doc; retire capture only on an explicit disposition |
| Archive, discard, restore | Apply Justin's disposition to the same ID; preserve history |
| Collect source updates | Follow `references/ingestion.md`; use configured accounts/scopes only |
