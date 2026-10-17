import {createHash} from 'node:crypto';

const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
};
const instant = value => {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Use an observed timestamp with an explicit timezone');
  return Date.parse(value);
};
export function validateConfig(config) {
  if (config.contract_version !== 1 || typeof config.enabled !== 'boolean' || !Array.isArray(config.sources)) throw new Error('Provider contract_version 1, explicit enabled flag and sources are required');
  if (config.overlap_hours !== 48 || config.initial_lookback?.email_days !== 7 || config.initial_lookback?.calendar_days !== 14) throw new Error('Capture requires 48-hour overlap, 7-day email lookback and 14-day calendar coverage');
  const seen = new Set();
  for (const source of config.sources) {
    text(source.source_key, 'source_key'); text(source.provider, 'provider'); text(source.account_email, 'account_email');
    if (!source.account_email.includes('@') || !['mailbox', 'calendar'].includes(source.scope?.kind)) throw new Error('An exact account and typed mailbox/calendar scope are required');
    text(source.scope.id, 'scope.id');
    if (typeof source.enabled !== 'boolean') throw new Error('Each source needs an explicit enabled flag');
    if (seen.has(source.source_key)) throw new Error('Duplicate source_key');
    seen.add(source.source_key);
  }
  return config;
}
export function sourceFor(config, envelope) {
  validateConfig(config);
  const source = config.sources.find(item => item.source_key === envelope.source_key);
  if (!config.enabled || !source?.enabled) throw new Error('Ingestion source is disabled or unconfigured');
  if (source.provider !== envelope.provider || source.account_email.toLowerCase() !== envelope.account_email?.toLowerCase() || source.scope.id !== envelope.scope_id) throw new Error('Provider, account or exact source scope does not match');
  for (const field of ['item_id', 'subject']) text(envelope[field], field);
  if (!['etag', 'revision', 'updated_at', 'fingerprint'].includes(envelope.revision?.kind)) throw new Error('An observed revision or content fingerprint is required');
  text(envelope.revision.value, 'revision.value');
  for (const field of ['source_url', 'source_updated']) if (envelope[field] !== null && typeof envelope[field] !== 'string') throw new Error(`${field} must be a string or null`);
  if (envelope.source_updated !== null) instant(envelope.source_updated);
  return source;
}
export function coverageWindow(config, sourceKey, asOf, checkpoint = null) {
  validateConfig(config);
  const source = config.sources.find(item => item.source_key === sourceKey);
  if (!config.enabled || !source?.enabled) throw new Error('Ingestion source is disabled or unconfigured');
  const now = instant(asOf), day = 86_400_000;
  const initialDays = source.scope.kind === 'calendar' ? config.initial_lookback.calendar_days : config.initial_lookback.email_days;
  if (checkpoint && checkpoint.source_key !== sourceKey) throw new Error('Checkpoint belongs to another source');
  const prior = checkpoint ? instant(checkpoint.verified_success_through) : null;
  if (prior !== null && prior > now) throw new Error('Checkpoint is ahead of the observed snapshot');
  return {source_key: sourceKey, after: new Date(prior === null ? now - initialDays * day : prior - config.overlap_hours * 3_600_000).toISOString(),
    through: new Date(now).toISOString(),
    calendar_from: source.scope.kind === 'calendar' ? new Date(now - 14 * day).toISOString() : null,
    calendar_through: source.scope.kind === 'calendar' ? new Date(now + 14 * day).toISOString() : null};
}
export function identity(envelope) {
  return JSON.stringify([envelope.provider, envelope.account_email.toLowerCase(), envelope.scope_id, envelope.item_id]);
}
export function fingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) throw new Error('Fingerprint requires actual observed source material');
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return {kind: 'fingerprint', value: createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex')};
}
export function verifiedReceipt(config, envelope, intended, readback, verifiedTime) {
  sourceFor(config, envelope); instant(verifiedTime);
  if (!['capture', 'update', 'unchanged', 'review'].includes(intended.action) || !['Inbox', 'Backlog'].includes(intended.destination)) throw new Error('Receipt needs an explicit action and writable destination');
  text(intended.ID, 'immutable ID'); text(intended.subject, 'canonical subject');
  if (!readback || readback.ID !== intended.ID || readback.subject !== intended.subject || readback.destination !== intended.destination) throw new Error('Canonical readback must match before saving a receipt');
  return {contract_version: 1, source_key: envelope.source_key, identity: identity(envelope), provider: envelope.provider,
    account_email: envelope.account_email, scope_id: envelope.scope_id, item_id: envelope.item_id,
    revision: {...envelope.revision}, ID: intended.ID, subject: intended.subject, action: intended.action,
    destination: intended.destination, verified_time: verifiedTime};
}
export function advanceCheckpoint(config, sourceKey, through, items, receipts, coverage) {
  validateConfig(config); instant(through);
  if (!coverage || coverage.source_key !== sourceKey || instant(coverage.through) !== instant(through) ||
      coverage.complete !== true || coverage.all_pages_read !== true || !Array.isArray(coverage.failures) || coverage.failures.length)
    throw new Error('Complete scoped read coverage is required before advancing a checkpoint');
  for (const envelope of items) {
    sourceFor(config, envelope);
    if (envelope.source_key !== sourceKey) throw new Error('Batch contains another source');
    const receipt = receipts.find(item => item.identity === identity(envelope) && item.source_key === sourceKey &&
      item.revision?.kind === envelope.revision.kind && item.revision?.value === envelope.revision.value);
    if (receipt?.contract_version !== 1 || !receipt.ID || !receipt.subject ||
        !['capture', 'update', 'unchanged', 'review'].includes(receipt.action) || !['Inbox', 'Backlog'].includes(receipt.destination) ||
        receipt.provider !== envelope.provider || receipt.account_email?.toLowerCase() !== envelope.account_email.toLowerCase() ||
        receipt.scope_id !== envelope.scope_id || receipt.item_id !== envelope.item_id || !receipt.verified_time)
      throw new Error('Partial/unverified batch cannot advance the checkpoint');
    instant(receipt.verified_time);
  }
  if (!config.enabled || !config.sources.some(source => source.source_key === sourceKey && source.enabled)) throw new Error('Ingestion source is disabled or unconfigured');
  return {source_key: sourceKey, verified_success_through: through};
}
