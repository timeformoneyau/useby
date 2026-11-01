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

## Where the trust engine lives

The shadow trust engine this measures is **not on `main`**. It is on
`claude/capture-context-loss-spike-2ivfmb` at `0c70008`, pushed and unmerged,
with its matching proxy branch also unmerged and not in production. This harness
reads the log format that branch emits, so a session must be collected from a
build made from it. See the Build Log entry *2026-08-30 — Recognition evidence
contract + shadow trust engine*.

## The one measurement gap

Almost everything comes off the export with no manual work. The `outcome` line
records whether the user corrected the date, so **coverage, the rejection
histogram, and the false-accept rate all compute from the logs alone**.

What the logs never record is **what a corrected date was corrected *to***.
`dateChanged` is a boolean; the new value is not written anywhere. So:

- *Whether* a would-be accept was wrong — **from the logs.**
- *By how many days, and in which direction* — **not in the logs.**

That matters only for the dangerous-overshoot criterion, which is about
magnitude and direction. So the ground-truth file is needed **only for the scans
that were actually wrong** — typically a handful per session — and the report
prints a ready-to-fill stub naming exactly which `scanId`s it needs and what the
gate proposed for each. The dangerous criterion reports INSUFFICIENT EVIDENCE
while any error's size is unknown; it never assumes a small one.

Closing that gap would mean logging the corrected date alongside `dateChanged`,
which is a change to the app and deliberately not part of this task.

Two smaller notes found while reading the emitters:

- The app's own `falseAccept` flag is `auto_accept && dateChanged` — it does not
  count a corrected **item name**. This harness counts a corrected name as a
  false accept too, reports both, and flags any scan where the two disagree.
- `useby.trust` lines live only in Android's log buffer. Nothing is persisted,
  so a long session can roll them away. The report counts decisions with no
  outcome line, which is what that looks like.

---

## What it measures

For every scan in the export:

- **Dataset integrity** — scans discovered, unique ids, duplicate lines,
  malformed lines, decisions with no outcome line, date errors with no truth
  supplied, and every exclusion with its reason. Nothing is discarded silently;
  if a record is not evaluated, it is counted and named.
- **Gate coverage** — how many scans the gate would have auto-accepted, how many
  it sent to review, the coverage and rejection rates, and a histogram of
  `blocking` reasons with each reason kept separate rather than collapsed into
  "rejected". Advisory reasons are histogrammed apart, since they never cost
  coverage.
- **Accuracy of would-be accepts** — date correctness, item-name correctness,
  and the error distribution split by **direction**, where its size is known.
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
no `useby.` lines, so pointing it at a whole capture directory is fine.

```bash
adb logcat -d -s ReactNativeJS | grep useby. > logs/session-2026-09-14.log
```

Dump promptly after each session: these lines live only in the Android log
buffer and a long or noisy run will roll them away.

Four line kinds are read, all keyed by `scanId`:

| Line | Stage | Carries |
|---|---|---|
| `useby.scan` | `capture` | camera and resize timings |
| `useby.scan` | `request` | the round trip, read quality, outcome |
| `useby.trust` | `decision` | `verdict`, `blocking[]`, `advisory[]`, `sawText`, `derivedIso`, `modelIso`, `format`, `nameLen` |
| `useby.trust` | `outcome` | `action`, and on a save `dateChanged`, `dateSupplied`, `nameChanged`, `typeChanged`, `falseAccept` |

The `useby.trust` pair is the measurement; the `useby.scan` lines are read for
dataset integrity. Lines carrying a marker that then fail to parse are counted
as **malformed** and reported; lines that are not ours are ignored entirely.

**How verdicts map onto the report.** `auto_accept` is a would-be auto-accept.
`review` is a rejection, and its `blocking` reasons make the histogram.
`failed` is excluded from the coverage denominator entirely — that is the
engine's own distinction, and it is right: a photograph of a bag of onions is
not a gate failure. Scans that were discarded or retaken are excluded too, since
the user never settled on a value and there is no truth for them.

### Ground truth (only for the scans that were wrong)

JSON array, `{"scans": [...]}`, or one JSON object per line. Most sessions need
only a few rows, and the report tells you which:

```json
{
  "scans": [
    { "scanId": "p-mfk3a004-0004d", "truthDate": "2026-09-10" },
    { "scanId": "p-mfk3a006-0006f", "truthDate": "2026-09-05" }
  ]
}
```

| Field | Required? | What it is |
|---|---|---|
| `scanId` | Yes | Matches the id in the log lines. `^[A-Za-z0-9_-]{1,64}$` |
| `truthDate` | For each scan whose date was corrected | `YYYY-MM-DD` — the date the user settled on. Without it the error is counted but its size is unknown |
| `proposedDate` | No | Overrides `modelIso` from the decision line. For datasets collected before that field existed |
| `verdict` | No | `auto_accept`/`review`/`failed`, where the decision line was lost |
| `nameCorrect` | No | Overrides the `nameChanged` boolean. **A boolean, never a name** |

**There is no item-name field, on purpose.** The app records name length and a
changed/unchanged boolean, never the text — that is the contents of someone's
fridge — and this harness does not become the place it reappears. A record that
includes a name anyway has it dropped at the parser, and there is a test
asserting no name text reaches either output.

Bad rows are rejected individually with a named reason and counted in the
report. One typo does not cost you the session.

### Where the log and the file disagree

The log wins, and the disagreement is **reported, not reconciled** — the scan is
excluded as `verdict-conflict` or `proposed-date-conflict`. A log line and
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
`direction`, `nameCorrect`, the verdict with its blocking and advisory reasons,
and the evidence off the decision line — `sawText` (the characters the packaging
printed), `format`, and both `derivedIso` and `modelIso` so a disagreement
between the two routes is visible. Enough to diagnose the failure, and nothing
about what the food was.

---

## Options

| Option | Default | |
|---|---|---|
| `--ground-truth <path>` | — | Corrected dates for the scans that were wrong |
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

Nothing breached, but the data cannot establish the claim. Two things produce
it, and both are reported with the numbers from your run:

- **The sample is too small.** Common for a first session, and **not** a soft
  pass.
- **A date error's size is unknown** because no `truthDate` was supplied for it.
  The report names the `scanId`s and prints a stub to fill in.

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

- **Error magnitude is not in the logs.** The size and direction of a corrected
  date must be supplied by hand, so the dangerous-overshoot criterion depends on
  the collector filling in a few rows after each session. The harness reports
  INSUFFICIENT EVIDENCE rather than assuming an unmeasured error was small.
- **A scan waved through uncorrected is recorded as correct.** The whole
  measurement rests on the collector actually correcting everything that was
  wrong, including things they might not notice. This is the largest source of
  optimism in the result and nothing in the tool can detect it.
- **The log buffer is the only store.** Nothing is persisted on the device, so a
  long or noisy session loses lines. The report counts decisions with no outcome
  line, which is what that looks like from here.
- **The app's `falseAccept` flag counts the date only**, not a corrected item
  name. Both numbers are reported and a disagreement is flagged, but the two
  definitions are genuinely different and it is worth knowing which one a
  quoted figure came from.
- **It measures the gate as it behaved during collection.** It says nothing
  about how a changed gate would behave, and re-running it after tuning the gate
  on the same dataset measures the tuning, not the gate. The ablation the Build
  Log describes needs held-out data.
- **One session is one sample.** Packaging, lighting and phone are held roughly
  constant within a session; the bound describes the observed conditions, not
  every fridge.
- **`sawText` and `sawLabel` are printed characters**, which the app treats as
  properties of the packaging rather than of the person. They appear in failure
  records. Item names never do.

---

## Layout

```
tools/scan-analysis/stats.mjs      Clopper-Pearson, incomplete beta. No dependencies
tools/scan-analysis/parse.mjs      useby.scan + useby.trust lines → joined scans;
                                   ground-truth file reading
tools/scan-analysis/analyse.mjs    Pure: scans in, verdict out. No IO, no clock
tools/scan-analysis/report.mjs     Renders the Markdown. Computes nothing
tools/scan-analysis/cli.mjs        Arguments and files, and nothing that decides anything
tools/scan-analysis/fixtures/      A worked session and its ground truth
                                   (named .txt, not .log — .gitignore excludes *.log,
                                    which is right for real exports and wrong for a fixture)
scripts/scan-analysis.test.mjs     38 tests, run by `npm test`
```

Nothing here is imported by the app. It is plain ESM on the Node standard
library, outside `src/`, and no runtime code path reaches it.
