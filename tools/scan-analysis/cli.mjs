#!/usr/bin/env node
/**
 * One command between a testing session and an answer.
 *
 *   npm run analyse:scans -- ./logs --ground-truth ./truth.json
 *
 * The whole point of this harness is that the person who spent an afternoon
 * scanning packaging does not then spend an evening in a spreadsheet. So the
 * default behaviour is: point it at whatever came off the phone, read the
 * verdict on stdout, and stop.
 *
 * Argument handling and file IO live here and nowhere else. Everything that
 * decides anything is in `analyse.mjs`, which touches no filesystem and no
 * clock it was not handed — that separation is what lets the fixtures test the
 * conclusions rather than the plumbing.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { analyse, DEFAULT_THRESHOLDS } from './analyse.mjs';
import { loadAnnotations, loadLogs } from './parse.mjs';
import { renderReport } from './report.mjs';

const USAGE = `
Analyse exported UseBy scan logs against the shadow trust gate's safety bar.

  node tools/scan-analysis/cli.mjs <log-path...> [options]

Arguments
  <log-path...>              A logcat capture, or a directory of them. Files
                             without 'useby.scan' lines are ignored.

Options
  --ground-truth <path>      Ground-truth / gate annotations, keyed by scanId.
                             JSON array, {"scans":[...]}, or one object per line.
  --json <path>              Write the machine-readable result here.
  --markdown <path>          Write the report here instead of stdout.
  --max-false-accept-rate <n>   Default ${DEFAULT_THRESHOLDS.maxFalseAcceptRate}
  --dangerous-later-days <n>    Default ${DEFAULT_THRESHOLDS.dangerousLaterDays}
  --max-dangerous-rate <n>      Default ${DEFAULT_THRESHOLDS.maxDangerousAcceptRate}
  --confidence <n>              Default ${DEFAULT_THRESHOLDS.confidence}
  --now <iso>                Fix the analysis timestamp (for reproducible runs).
  --quiet                    Suppress the report on stdout.
  --strict                   Exit non-zero unless the verdict is PASS.
  -h, --help                 This.

Exit codes
  0  the analysis ran (whatever the verdict), or PASS under --strict
  1  the analysis could not run: bad arguments, unreadable input
  2  --strict and the verdict was FAIL or INSUFFICIENT EVIDENCE

A verdict of PASS is a statement about a dataset. It does not authorise
enabling exception-based review; that remains a separate product decision.
`.trim();

export function parseArgs(argv) {
  const options = {
    logPaths: [],
    groundTruth: null,
    json: null,
    markdown: null,
    thresholds: {},
    now: null,
    quiet: false,
    strict: false,
    help: false,
  };

  const numeric = {
    '--max-false-accept-rate': 'maxFalseAcceptRate',
    '--dangerous-later-days': 'dangerousLaterDays',
    '--max-dangerous-rate': 'maxDangerousAcceptRate',
    '--confidence': 'confidence',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };

    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--ground-truth') options.groundTruth = value();
    else if (arg === '--json') options.json = value();
    else if (arg === '--markdown') options.markdown = value();
    else if (arg === '--now') options.now = value();
    else if (numeric[arg] !== undefined) {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${arg} needs a non-negative number, got "${raw}".`);
      }
      options.thresholds[numeric[arg]] = parsed;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}". Try --help.`);
    } else {
      options.logPaths.push(arg);
    }
  }

  return options;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function main(argv, io = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    io.error(e.message);
    return 1;
  }

  if (options.help) {
    io.log(USAGE);
    return 0;
  }
  if (options.logPaths.length === 0) {
    io.error('No log path given.\n');
    io.error(USAGE);
    return 1;
  }

  let logs;
  try {
    logs = loadLogs(options.logPaths);
  } catch (e) {
    io.error(`Could not read the logs: ${e.message}`);
    return 1;
  }

  let annotations = { records: [], rejected: [], duplicates: [] };
  if (options.groundTruth !== null) {
    try {
      annotations = loadAnnotations(options.groundTruth);
    } catch (e) {
      io.error(`Could not read the ground truth: ${e.message}`);
      return 1;
    }
    if (annotations.fatal !== undefined) {
      io.error(`Ground truth is not valid JSON: ${annotations.fatal}`);
      return 1;
    }
  }

  const result = analyse({
    scans: logs.scans,
    annotations: annotations.records,
    malformedLogLines: logs.malformed,
    rejectedAnnotations: annotations.rejected,
    duplicateAnnotations: annotations.duplicates,
    thresholds: options.thresholds,
    now: options.now === null ? new Date() : new Date(options.now),
    inputs: {
      logPaths: options.logPaths,
      logFilesRead: logs.files.length,
      traceLinesRead: logs.lineCount,
      groundTruthPath: options.groundTruth,
    },
  });

  const markdown = renderReport(result);
  if (options.markdown !== null) write(options.markdown, markdown);
  else if (!options.quiet) io.log(markdown);

  if (options.json !== null) write(options.json, `${JSON.stringify(result, null, 2)}\n`);

  if (options.strict && result.safetyBar.result !== 'PASS') return 2;
  return 0;
}

// Only when run as a program. Importing this file must not exit the process —
// the tests import `main` and call it directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
