/**
 * Reading what a device testing session actually produced.
 *
 * Two inputs, because the app currently emits only one of them.
 *
 * The logs are the `useby.scan` lines described in the README — one `capture`
 * line and one `request` line per scan, joined on `scanId`. That is a real,
 * shipped contract and this module reads it as it is rather than as anyone
 * would like it to be.
 *
 * The annotations file is everything the logs deliberately do not carry. The
 * diagnostic design excludes item names on purpose (they are the contents of
 * someone's fridge) and the app has never logged the user's corrections at all,
 * so ground truth cannot come from the device. It is supplied by hand, per
 * scanId, in the shape `readAnnotations` accepts. `docs/scan-analysis.md` is
 * the contract; see also the measurement gap recorded there.
 *
 * Nothing here throws on bad input. A testing session is expensive to collect
 * and a parser that dies on line 300 of 400 would waste it — every problem
 * becomes a counted, named record instead, and the report shows all of them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The marker `scanTrace` writes. Everything before it on the line is logcat's. */
const MARKER = 'useby.scan ';

/** The id shape the app mints and the proxy validates. Restated, not imported: */
/* this file must stay runnable with no app code loaded at all. */
const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a well-formed YYYY-MM-DD that is also a real calendar date. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** Whole days from `from` to `to`. Positive means `to` is later. */
export function dayDifference(from, to) {
  const a = Date.UTC(...from.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  const b = Date.UTC(...to.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  return Math.round((b - a) / 86_400_000);
}

/** Every file under a path, or the path itself if it is a file. Sorted, so runs repeat. */
export function collectFiles(path) {
  const info = statSync(path);
  if (!info.isDirectory()) return [path];
  const out = [];
  for (const entry of readdirSync(path).sort()) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) out.push(...collectFiles(child));
    else out.push(child);
  }
  return out;
}

/**
 * Pull the trace entries out of raw log text.
 *
 * A logcat capture is mostly not ours — timestamps, pids, other tags, and any
 * amount of unrelated chatter. Lines without the marker are not errors and are
 * not counted as anything; lines *with* the marker that then fail to parse are
 * the ones worth surfacing, because they are ours and they are broken.
 */
export function readLogLines(text, source = '<input>') {
  const entries = [];
  const malformed = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const at = line.indexOf(MARKER);
    if (at === -1) return;

    const where = { source, line: index + 1 };
    const raw = line.slice(at + MARKER.length).trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed.push({ ...where, problem: 'unparseable-json' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformed.push({ ...where, problem: 'not-an-object' });
      return;
    }
    if (typeof parsed.scanId !== 'string' || !SCAN_ID.test(parsed.scanId)) {
      malformed.push({ ...where, problem: 'missing-or-invalid-scanId' });
      return;
    }
    if (parsed.stage !== 'capture' && parsed.stage !== 'request') {
      malformed.push({ ...where, problem: 'unknown-stage', scanId: parsed.scanId });
      return;
    }
    entries.push({ ...where, entry: parsed });
  });

  return { entries, malformed };
}

/**
 * Read the gate's verdict off a request line, if one is there.
 *
 * Nothing in the app writes this today — the shadow trust engine this harness
 * was built to measure does not exist in this repository yet (see
 * `docs/scan-analysis.md`). The reader is here so that when the engine does log
 * a decision into the request line, the harness picks it up with no change;
 * until then every gate decision arrives through the annotations file instead.
 *
 * Kept deliberately small and tolerant: if the eventual implementation names
 * things differently, this one function is what changes.
 */
export function readGate(entry) {
  const gate = entry?.gate ?? entry?.trust;
  if (typeof gate !== 'object' || gate === null) return null;
  const decision =
    gate.decision === 'accept' || gate.decision === 'reject' ? gate.decision : null;
  if (decision === null) return null;
  const reasons = Array.isArray(gate.reasons)
    ? gate.reasons.filter((r) => typeof r === 'string' && r.length > 0).map((r) => r.slice(0, 60))
    : [];
  return { decision, reasons, origin: 'log' };
}

/**
 * Fold trace entries into one record per scan.
 *
 * Duplicates are kept, not overwritten. A second `request` line for the same id
 * means either the log was concatenated twice or an id collided, and both of
 * those change what the numbers mean — so the extras are retained on the record
 * and the scan is excluded from evaluation rather than being silently counted
 * once with whichever copy happened to be last.
 */
export function joinScans(entries) {
  const scans = new Map();
  for (const { entry, source, line } of entries) {
    let scan = scans.get(entry.scanId);
    if (!scan) {
      scan = { scanId: entry.scanId, capture: null, request: null, duplicates: [] };
      scans.set(entry.scanId, scan);
    }
    const slot = entry.stage === 'capture' ? 'capture' : 'request';
    if (scan[slot] === null) scan[slot] = { entry, source, line };
    else scan.duplicates.push({ stage: entry.stage, source, line });
  }
  // Sorted by id, which is time-ordered by construction, so two runs over the
  // same logs produce byte-identical output.
  return [...scans.values()].sort((a, b) => (a.scanId < b.scanId ? -1 : 1));
}

/** Load and join every log file under the given paths. */
export function loadLogs(paths) {
  const entries = [];
  const malformed = [];
  const files = [];

  for (const path of paths) {
    for (const file of collectFiles(path)) {
      files.push(file);
      const read = readLogLines(readFileSync(file, 'utf8'), file);
      entries.push(...read.entries);
      malformed.push(...read.malformed);
    }
  }

  return { files, scans: joinScans(entries), malformed, lineCount: entries.length };
}

/**
 * Validate one hand-supplied annotation.
 *
 * The fields are the minimum needed to score a scan, and the omissions are
 * deliberate. There is no item-name field: the app's diagnostics avoid item
 * names by design and this tool is not the place to reintroduce them, so name
 * accuracy is supplied as a boolean somebody has already decided. A record that
 * carries a name anyway has it dropped, not stored.
 */
export function validateAnnotation(record, index) {
  const where = { index };

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { ok: false, ...where, problem: 'not-an-object' };
  }
  if (typeof record.scanId !== 'string' || !SCAN_ID.test(record.scanId)) {
    return { ok: false, ...where, problem: 'missing-or-invalid-scanId' };
  }

  const id = { ...where, scanId: record.scanId };

  const dateOrNull = (value, field) => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (!isIsoDate(value)) return { ok: false, problem: `invalid-${field}` };
    return { ok: true, value };
  };

  const truth = dateOrNull(record.truthDate, 'truthDate');
  if (!truth.ok) return { ok: false, ...id, problem: truth.problem };

  const proposed = dateOrNull(record.proposedDate, 'proposedDate');
  if (!proposed.ok) return { ok: false, ...id, problem: proposed.problem };

  if (record.nameCorrect !== undefined && typeof record.nameCorrect !== 'boolean') {
    return { ok: false, ...id, problem: 'invalid-nameCorrect' };
  }

  let gate = null;
  if (record.gate !== undefined && record.gate !== null) {
    gate = readGate({ gate: record.gate });
    if (gate === null) return { ok: false, ...id, problem: 'invalid-gate' };
    gate = { ...gate, origin: 'annotation' };
  }

  return {
    ok: true,
    ...id,
    truthDate: truth.value,
    proposedDate: proposed.value,
    nameCorrect: record.nameCorrect,
    gate,
  };
}

/**
 * Read an annotations file. Accepts a JSON array, a `{ scans: [...] }` envelope,
 * or one JSON object per line — whichever is least annoying to produce by hand
 * or to emit from a spreadsheet export.
 */
export function readAnnotations(text, source = '<annotations>') {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { records: [], rejected: [], duplicates: [] };

  let raw;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      // A whole unusable file is different from one bad row, and pretending
      // otherwise would report "0 scans have ground truth" for a typo.
      if (!trimmed.startsWith('{')) {
        return { records: [], rejected: [{ index: 0, problem: 'unparseable-file' }], duplicates: [], fatal: e.message };
      }
      raw = null;
    }
    if (parsed !== undefined) {
      raw = Array.isArray(parsed) ? parsed : parsed?.scans;
      if (!Array.isArray(raw)) {
        return { records: [], rejected: [{ index: 0, problem: 'not-an-array' }], duplicates: [] };
      }
    }
  }

  if (raw === null || raw === undefined) {
    raw = [];
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      try {
        raw.push(JSON.parse(line));
      } catch {
        raw.push({ __malformedLine: i + 1 });
      }
    }
  }

  const records = new Map();
  const rejected = [];
  const duplicates = [];

  raw.forEach((record, index) => {
    if (record && record.__malformedLine !== undefined) {
      rejected.push({ index, source, problem: 'unparseable-json', line: record.__malformedLine });
      return;
    }
    const checked = validateAnnotation(record, index);
    if (!checked.ok) {
      rejected.push({ ...checked, source });
      return;
    }
    if (records.has(checked.scanId)) {
      duplicates.push({ scanId: checked.scanId, index, source });
      return;
    }
    records.set(checked.scanId, checked);
  });

  return { records: [...records.values()], rejected, duplicates };
}

export function loadAnnotations(path) {
  return readAnnotations(readFileSync(path, 'utf8'), path);
}
