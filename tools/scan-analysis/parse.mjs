/**
 * Reading what a device testing session actually produced.
 *
 * The app writes two families of line, both one JSON object per scan stage and
 * both keyed by `scanId`:
 *
 *   useby.scan   capture | request   the camera and the round trip
 *   useby.trust  decision | outcome  what the shadow gate would have done,
 *                                    and what the person then actually did
 *
 * The `useby.trust` pair is the measurement. The `decision` line carries the
 * verdict, every blocking and advisory reason, the printed characters the model
 * reported, and both routes' reading of them. The `outcome` line, written at
 * Save, Discard or Retake, carries what the user changed. A verdict alone proves
 * nothing and a correction alone says nothing about whether the gate would have
 * caught it; the pair is what answers the question.
 *
 * The `useby.scan` lines are read too, for dataset integrity — a scan whose
 * capture line exists but whose trust lines never arrived is a different problem
 * from one that was never attempted.
 *
 * One thing is genuinely not in the logs: the corrected date itself. The outcome
 * line records `dateChanged` as a boolean, never the value, so *whether* a
 * would-be accept was wrong is measurable from the export alone but *by how many
 * days, and in which direction* is not. That is what the annotations file is
 * for, and it is only ever needed for the scans that were actually wrong. See
 * `docs/scan-analysis.md`.
 *
 * Nothing here throws on bad input. A testing session is expensive to collect
 * and a parser that dies on line 300 of 400 would waste it — every problem
 * becomes a counted, named record instead, and the report shows all of them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two markers the app writes. Everything before one on the line is logcat's
 * own — timestamp, pid, tag — and everything after it is our JSON.
 */
const MARKERS = [
  { marker: 'useby.trust ', kind: 'trust', stages: ['decision', 'outcome'] },
  { marker: 'useby.scan ', kind: 'scan', stages: ['capture', 'request'] },
];

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
    const found = MARKERS.map((m) => ({ ...m, at: line.indexOf(m.marker) })).find(
      (m) => m.at !== -1,
    );
    if (found === undefined) return;

    const where = { source, line: index + 1, kind: found.kind };
    const raw = line.slice(found.at + found.marker.length).trim();

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
    if (!found.stages.includes(parsed.stage)) {
      malformed.push({ ...where, problem: 'unknown-stage', scanId: parsed.scanId });
      return;
    }
    entries.push({ ...where, stage: parsed.stage, entry: parsed });
  });

  return { entries, malformed };
}

/** The three verdicts the shadow gate can reach. `none` means it never ran. */
const VERDICTS = ['auto_accept', 'review', 'failed'];

/**
 * Read the gate's verdict off a `decision` line.
 *
 * `blocking` is what the gate rejected on and `advisory` is what it merely
 * noted; they are kept apart because collapsing them would put reasons that
 * never blocked anything into the rejection histogram, which is the output that
 * says where future work would pay.
 *
 * Defensive about types throughout: these lines are read back from a log buffer
 * that may have been truncated mid-write, and a half-line that still parses as
 * JSON is not impossible.
 */
export function readDecision(entry) {
  if (typeof entry !== 'object' || entry === null) return null;
  if (!VERDICTS.includes(entry.verdict)) return null;

  const reasons = (value) =>
    Array.isArray(value)
      ? value.filter((r) => typeof r === 'string' && r.length > 0).map((r) => r.slice(0, 60))
      : [];

  const iso = (value) => (typeof value === 'string' && isIsoDate(value) ? value : null);

  return {
    verdict: entry.verdict,
    blocking: reasons(entry.blocking),
    advisory: reasons(entry.advisory),
    // What the editor was prefilled with. `derivedIso` is the rules' own
    // reading of the same characters, kept beside it because a disagreement
    // between the two is itself a blocking reason (PARSE_MISMATCH).
    modelIso: iso(entry.modelIso),
    derivedIso: iso(entry.derivedIso),
    format: typeof entry.format === 'string' ? entry.format : null,
    // Printed characters, not personal data — the packaging said them. These
    // are the whole evidence base for diagnosing a rejection.
    sawText: typeof entry.sawText === 'string' ? entry.sawText : null,
    sawLabel: typeof entry.sawLabel === 'string' ? entry.sawLabel : null,
    others: Number.isInteger(entry.others) ? entry.others : null,
    hasName: Number.isInteger(entry.nameLen) ? entry.nameLen > 0 : null,
  };
}

/** The three ways a scan ends, all informative. */
const ACTIONS = ['saved', 'discarded', 'retaken'];

/**
 * Read what the user actually did off an `outcome` line.
 *
 * The correction flags are only written on a save — there is nothing to compare
 * against when a draft is discarded or retaken — so they are read as
 * `undefined` rather than `false` on those, which is the difference between
 * "they changed nothing" and "there was nothing to change".
 */
export function readOutcome(entry) {
  if (typeof entry !== 'object' || entry === null) return null;
  if (!ACTIONS.includes(entry.action)) return null;

  const flag = (value) => (typeof value === 'boolean' ? value : undefined);

  return {
    action: entry.action,
    verdict: VERDICTS.includes(entry.verdict) ? entry.verdict : null,
    dateChanged: flag(entry.dateChanged),
    dateSupplied: flag(entry.dateSupplied),
    nameChanged: flag(entry.nameChanged),
    typeChanged: flag(entry.typeChanged),
    // The app computes this itself, as `auto_accept && dateChanged`. Read for
    // cross-checking rather than relied on: it does not count a corrected item
    // name, and this harness does.
    falseAccept: flag(entry.falseAccept),
  };
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
  const SLOTS = { capture: 'capture', request: 'request', decision: 'decision', outcome: 'outcome' };

  for (const { entry, stage, source, line } of entries) {
    let scan = scans.get(entry.scanId);
    if (!scan) {
      scan = {
        scanId: entry.scanId,
        capture: null,
        request: null,
        decision: null,
        outcome: null,
        duplicates: [],
      };
      scans.set(entry.scanId, scan);
    }
    const slot = SLOTS[stage];
    if (scan[slot] === null) scan[slot] = { entry, source, line };
    else scan.duplicates.push({ stage, source, line });
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
 * Most of a session needs none of these. The logs already say whether a
 * would-be accept was wrong — `dateChanged` on the outcome line — so coverage,
 * the rejection histogram and the false-accept rate all come straight off the
 * export. What the logs never record is the corrected *value*, so the size and
 * direction of an error are not recoverable from them.
 *
 * That makes this file small by design: it is needed only for the scans that
 * were actually wrong, to supply the date the user settled on. Everything else
 * is optional and exists for overriding or for datasets collected before some
 * part of the instrumentation existed.
 *
 * There is deliberately no item-name field. The app's diagnostics record name
 * length and a changed/unchanged boolean, never the text — that is the contents
 * of someone's fridge — and this harness does not become the place it
 * reappears. A record carrying a name has it dropped, not stored.
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

  // A verdict may be supplied for a dataset whose decision lines were lost, but
  // it must be one the gate can actually reach.
  let verdict = null;
  if (record.verdict !== undefined && record.verdict !== null) {
    if (!VERDICTS.includes(record.verdict)) return { ok: false, ...id, problem: 'invalid-verdict' };
    verdict = record.verdict;
  }

  return {
    ok: true,
    ...id,
    truthDate: truth.value,
    proposedDate: proposed.value,
    nameCorrect: record.nameCorrect,
    verdict,
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
