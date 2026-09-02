# Scan analysis harness

Turns an afternoon of real-device scanning into one answer: **did the trust
hypothesis survive the data?**

```bash
npm run analyse:scans -- ./logs --ground-truth ./ground-truth.json
```

Offline. No service, no database, no dashboard, no spreadsheet. It reads files
and prints a report.

> **This tool does not authorise anything.** A `PASS` is a statement about a
> dataset, not permission to switch on exception-based review. Mandatory
> Review & Save stays in force until that is decided separately, as a product
> decision, by a person.

---

## Before anything else: the measurement gap

**There is no shadow trust engine in this repository yet.** It was inspected for
one — `src/domain/scan/`, the screens, and the log emitters — and nothing
produces a gate decision, a reason code, or an evidence record. The harness was
built anyway, because it is the thing that makes the eventual collection session
cheap, but two of the three inputs it needs must currently be supplied by hand.

Three gaps, in the order they bite:

1. **No gate decision is logged.** Nothing in the app decides accept/reject, so
   nothing writes one. Every gate decision therefore comes from the
   ground-truth file. When a trust engine does start logging one, the harness
   reads it from a `gate` (or `trust`) object on the `request` line with no
   change — see `readGate` in `tools/scan-analysis/parse.mjs`, which is the one
   function to adjust if the eventual field names differ.

2. **The proposed date is not logged.** `useby.scan` request lines carry
   *whether* a date was read (`"read":"both"`), what kind it was
   (`"type":"use_by"`) and whether it was flagged for checking
   (`"checks":{"date":false}`) — but never the date itself. So the date the gate
   would have accepted has to be supplied too. If a future build logs
   `proposedDate` on the request line, the harness prefers it automatically.

3. **Ground truth is not captured at all.** `handleSave` in
   `src/screens/AddItemScreen.tsx` writes the item and navigates away; it emits
   no log line, and the `scanId` never even reaches that screen — `AddScreenPrefill`
   has no field for it. So the user's correction, which *is* the ground truth,
   is not recoverable from the logs even in principle.

Closing gap 3 is the change with real leverage, and it is deliberately **not**
part of this task: it would mean touching the save path. Recorded here so the
decision is made on purpose rather than discovered mid-analysis.

Until then, ground truth is written by hand during the session — a phone note or
a line per scan is enough. It is dull, and this document is honest about that
being the current cost.

---

## What it measures

For every scan in the export:

- **Dataset integrity** — scans discovered, unique ids, duplicate lines,
  incomplete scans, malformed lines, records that could not be joined, scans
  with no ground truth, and every exclusion with its reason. Nothing is
  discarded silently; if a record is not evaluated, it is counted and named.
- **Gate coverage** — how many scans the gate would have auto-accepted, how many
  it rejected, the coverage and rejection rates, and a histogram of rejection
  reasons with each reason kept separate rather than collapsed into "rejected".
- **Accuracy of would-be accepts** — date correctness, item-name correctness
  where supplied, and the error distribution split by **direction**.
- **Dangerous overshoots** — accepted dates more than 30 days *later* than truth,
  listed individually.
- **False-auto-accept rate**, with an exact confidence bound.
- **A verdict** against the configured bar.

### Why direction is reported separately

A date read *earlier* than reality makes someone throw out good food. A date
read *later* than reality makes someone eat something that has gone off. Those
are not the same failure, and a mean absolute error would average them into one
number that hides the only one that matters. So the signed difference is carried
all the way to the verdict, and "more than 30 days later than truth" is a
criterion in its own right.

---

## Input

### Logs (required)

A file or a directory — the harness walks directories and ignores anything with
no `useby.scan` lines, so pointing it at a whole capture directory is fine.

```bash
adb logcat -s ReactNativeJS > logs/session-2026-09-14.log
```

The format is the one in the README's *Diagnosing a scan* section: one `capture`
line and one `request` line per scan, joined on `scanId`. Lines that contain the
`useby.scan` marker but do not parse are counted as **malformed** and reported;
lines that are not ours are ignored entirely.

### Ground truth (needed for any accuracy number)

JSON array, `{"scans": [...]}`, or one JSON object per line — whichever is
easiest to produce.

```json
{
  "scans": [
    {
      "scanId": "p-mfk2a001-0001a",
      "gate": { "decision": "accept", "reasons": [] },
      "proposedDate": "2026-09-14",
      "truthDate": "2026-09-14",
      "nameCorrect": true
    },
    {
      "scanId": "p-mfk2a003-0003c",
      "gate": {
        "decision": "reject",
        "reasons": ["item-name-missing", "date-confidence-below-high"]
      },
      "proposedDate": null,
      "truthDate": "2026-11-02",
      "nameCorrect": false
    }
  ]
}
```

**The minimum per `scanId`:**

| Field | Required? | What it is |
|---|---|---|
| `scanId` | Yes | Matches the id in the log lines. `^[A-Za-z0-9_-]{1,64}$` |
| `gate.decision` | Until the app logs one | `"accept"` or `"reject"`. Without it the scan is excluded as `no-gate-decision` |
| `gate.reasons` | On a rejection | Array of reason-code strings. Kept separate in the histogram |
| `proposedDate` | For any accept you want scored | `YYYY-MM-DD` — the date the gate would have committed |
| `truthDate` | For any accept you want scored | `YYYY-MM-DD` — the correct date. `null` means "not known", and the scan is reported as unmeasured rather than assumed correct |
| `nameCorrect` | Optional | `true`/`false`. **A boolean, never a name** |

**There is no item-name field, on purpose.** The app's diagnostics avoid
recording item names — that is the contents of someone's fridge — and this
harness does not become the place they reappear. Name accuracy is a decision
somebody has already made, supplied as a boolean. A record that includes a name
anyway has it dropped at the parser, and there is a test asserting no name text
reaches either output.

Bad rows are rejected individually with a named reason and counted in the
report. One typo does not cost you the session.

### Where the log and the file disagree

The log wins, and the disagreement is **reported, not reconciled** — the scan is
excluded as `gate-decision-conflict` or `proposed-date-conflict`. A log line and
a handwritten note disagreeing about the same scan means one of them is wrong
about what happened, and averaging over that would launder a bookkeeping error
into a measurement.

---

## Output

Both outputs come from one analysis, so they cannot disagree.

**Markdown** — on stdout, or `--markdown report.md`. Verdict in the first three
lines; everything below it answers "why does it say that".

**JSON** — `--json result.json`. Stable, versioned schema for later tooling:

```
schemaVersion, tool, toolVersion, analysedAt, inputs, thresholds,
dataset { counts, exclusionReasons, malformedLogLineReasons, ... },
coverage { evaluableScans, wouldBeAutoAccepted, rejected, rates, rejectionReasons },
accuracy { scored, correct, false, date direction counts, errorDistribution },
falseAcceptRate { numerator, denominator, observed, confidence { ... } },
dangerousDateErrors { thresholdDays, count, oneSidedUpperBound, records[] },
incorrectAccepts[], excluded[], unscorableAccepts[],
safetyBar { result, criteria[] }
```

Failure records carry `scanId`, `proposedDate`, `truthDate`, `diffDays`,
`direction`, `nameCorrect`, the gate decision and its reasons, and the read
quality / date type / check flags from the log line — enough to find the scan
again, and nothing about what the food was.

---

## Options

| Option | Default | |
|---|---|---|
| `--ground-truth <path>` | — | Ground-truth and gate annotations |
| `--json <path>` | — | Write the machine-readable result |
| `--markdown <path>` | stdout | Write the report to a file |
| `--max-false-accept-rate <n>` | `0.005` | 1 in 200 |
| `--dangerous-later-days <n>` | `30` | Days later than truth before an overshoot is dangerous |
| `--max-dangerous-rate <n>` | `0.005` | Bound the dangerous-overshoot rate must clear |
| `--confidence <n>` | `0.95` | Confidence level for every bound |
| `--now <iso>` | now | Fix the timestamp, for reproducible runs |
| `--quiet` | | No report on stdout |
| `--strict` | | Exit non-zero unless the verdict is `PASS` |

Exit codes: `0` the analysis ran (whatever the verdict), `1` it could not run,
`2` `--strict` and the verdict was not `PASS`.

The thresholds are **configurable analysis parameters, not product policy**.
They are the numbers currently proposed; they are not a decision anyone has
taken, and the gate must never be tuned to satisfy them.

---

## Reading the verdict

### PASS

The measured data satisfies the configured criteria, *and* the sample is large
enough for that to mean something — the statistical upper bound, not just the
observed rate, is inside the bar.

### FAIL

A criterion was breached on the evidence in hand: the observed rate is already
above the bar, or at least one accepted date was more than 30 days later than
truth. No interval makes an observed breach go away.

### INSUFFICIENT EVIDENCE

Nothing breached, but the sample cannot establish the rate. This is the common
result for a first session and it is **not** a soft pass.

> INSUFFICIENT EVIDENCE — 0 errors observed in 43 would-be accepts, but the
> 95% upper bound remains 6.73%, above 0.50%. 598 consecutive error-free
> scored accepts would settle it.

Every verdict prints its own calculated reason, with the numbers from your run.

---

## The statistics

**Method: exact Clopper-Pearson binomial intervals.** Implemented in
`tools/scan-analysis/stats.mjs` on a regularised incomplete beta function, with
no dependencies.

The verdict is decided on a **one-sided upper bound** at the configured
confidence, because the bar is one-directional: the question is "is the rate no
worse than 0.5%", and spending half the error budget on a lower bound nobody
asked about would report a looser limit than the evidence supports. The
two-sided interval is printed alongside it for context.

Clopper-Pearson was chosen because it is exact and conservative — it inverts the
binomial CDF rather than approximating it, so its coverage never falls below the
nominal level. Wald and Wilson are cheaper and anti-conservative near zero,
which is exactly where this whole exercise lives: Wald on 0 errors in 43 scans
returns the interval `[0, 0]`, declaring the bar met on no evidence at all.

**Zero observed failures does not prove a zero underlying failure probability.**
With no errors, the bound is the exact form of the rule of three,
`1 − α^(1/n)`:

| Clean scans | 95% upper bound on the true rate |
|---|---|
| 43 | 6.73% |
| 100 | 2.95% |
| 300 | 0.99% |
| **598** | **0.50%** — the first n that clears the bar |
| 1000 | 0.30% |

So roughly **600 consecutive error-free would-be accepts** are needed before a
0.5% bar can be established at 95% confidence. That number is worth knowing
before planning a collection session, not after.

The "zero dangerous overshoots" criterion is handled the same way. Observing
none is necessary but cannot be sufficient — zero in twelve is zero in twelve —
so it also has to clear a statistical bound (`--max-dangerous-rate`), or a tiny
clean sample would pass a rule stated as "never".

The arithmetic is tested against closed forms (Beta(1,n), Beta(n,1), the
arcsine distribution) and published Clopper-Pearson values (2 of 20 →
0.0123–0.3170; 1 of 10 → 0.0025–0.4450), not merely asserted to return numbers.

---

## Known limitations

- **The three instrumentation gaps above.** Gate decisions, proposed dates and
  ground truth are all hand-supplied today. Hand-entered data is the least
  reliable part of the pipeline, and the harness cannot detect a transcription
  error — only a disagreement with the log, where one exists to disagree with.
- **Scans without ground truth are unmeasured, never assumed correct.** They are
  counted, excluded from the rate, and listed as a limitation in the report. A
  session that annotates only the interesting scans will produce a rate that
  describes the annotated subset and nothing else.
- **It measures the gate as it behaved during collection.** It says nothing
  about how a changed gate would behave, and re-running it after tuning the gate
  on the same dataset measures the tuning, not the gate.
- **Item names are measured as a supplied boolean**, so name accuracy is only as
  good as whoever decided it, and there is no way to audit that decision from
  the output.
- **One session is one sample.** Packaging, lighting and phone are all held
  roughly constant within a session; the bound describes the observed
  conditions, not every fridge.

---

## Layout

```
tools/scan-analysis/stats.mjs      Clopper-Pearson, incomplete beta. No dependencies
tools/scan-analysis/parse.mjs      Log lines → joined scans; ground-truth file reading
tools/scan-analysis/analyse.mjs    Pure: scans in, verdict out. No IO, no clock
tools/scan-analysis/report.mjs     Renders the Markdown. Computes nothing
tools/scan-analysis/cli.mjs        Arguments and files, and nothing that decides anything
tools/scan-analysis/fixtures/      A worked session and its ground truth
                                   (named .txt, not .log — .gitignore excludes *.log,
                                    which is right for real exports and wrong for a fixture)
scripts/scan-analysis.test.mjs     33 tests, run by `npm test`
```

Nothing here is imported by the app. It is plain ESM on the Node standard
library, outside `src/`, and no runtime code path reaches it.
