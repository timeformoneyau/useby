/**
 * The pending-scan queue: what lets the camera stop waiting for the model.
 *
 * Until now a scan lived inside `CaptureScreen`. The screen awaited the proxy
 * and handed the result on as a navigation parameter, which meant exactly one
 * scan could be in flight and it had to land while that screen was still
 * mounted. Measured against production, that wait is ~1.85s of server time of
 * which the model is ~1.63s, and no amount of tuning the other 12% changes how
 * it feels standing at the bench with a bag of shopping. So the wait moves off
 * the critical path instead: the shutter enqueues, the camera returns to ready,
 * and results land here whenever they land.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **A scan outlives every screen.** Nothing here is a React component or a
 *      hook, so no unmount can cancel a request or drop a result. That is the
 *      whole structural point of the change.
 *   2. **A result can never be attached to the wrong scan.** Everything is keyed
 *      by the `scanId` minted at the shutter — the same id already threaded
 *      through the app's log line and the proxy's. Requests finish out of order
 *      routinely; the key is what makes that a non-event.
 *   3. **Nothing is saved without review.** A finished scan becomes a *draft*
 *      that the user opens into the existing Review & Save editor. There is no
 *      code path from here into `items/service`.
 *
 * Deliberately a factory rather than a bare module singleton. The singleton
 * lives one file over in `queue.ts`, wired to the real network call; this file
 * has no value imports at all, so Node's type stripping can load it directly
 * and the offline suite can build its own queue with a fake runner. Test
 * instances share nothing, which is the difference between testing a queue and
 * testing whatever the previous test left behind.
 */
import type { AddScreenPrefill } from '../../types';
import type { CaptureTimings } from './diagnostics';

/**
 * How many requests may be in the air at once.
 *
 * Not a throughput limit — the proxy is stateless, Vercel invocations are
 * independent, and a dozen scans is nothing for Haiku. It is a limit on
 * *upload*: each scan pushes ~200KB, and on a weak kitchen connection ten
 * simultaneous uploads finish later than ten sequential ones. Three is chosen
 * against the measured shape of the work rather than picked round: a person
 * shutters an item every two to four seconds and a scan takes two to three, so
 * the steady state is about one in flight and the cap only bites on a burst —
 * where it wants enough headroom to absorb the burst without serialising it.
 *
 * Queued scans are *not* capped. Hitting the limit must never stop someone
 * photographing groceries; it only delays when their request leaves the phone.
 */
export const MAX_ACTIVE = 3;

/**
 * Where a scan has got to.
 *
 * `ready` and `failed` are both terminal and both reviewable — that is the
 * point of separating them from a boolean. A failed scan is not a dead end and
 * must never be quietly dropped: it opens the same editor with a note on it,
 * exactly as a failed synchronous scan always has.
 *
 * A partial read (a name but no date, or the reverse) is `ready`. The proxy
 * answered, the pipeline worked, and the editor is built to be completed by
 * hand — treating that as a failure would misreport what happened.
 */
export type PendingStatus = 'queued' | 'active' | 'ready' | 'failed';

export interface PendingScan {
  scanId: string;
  status: PendingStatus;
  /** `Date.now()` at the shutter. Orders the strip the way they were photographed. */
  shutterAt: number;
  /**
   * `Date.now()` when the scan reached a terminal status. Absent until then.
   *
   * Deliberately not the same ordering as `shutterAt`. Requests finish out of
   * order routinely, so "the one that just came back" is a different question
   * from "the one photographed most recently" — and the camera card asks the
   * first. Without this the card would show a stale result every time an
   * earlier scan overtook a later one.
   */
  settledAt?: number;
  /**
   * The resized JPEG on disk — the exact image the model was given.
   *
   * Held for the whole life of the draft rather than released with the upload,
   * because it is what makes a draft identifiable. "Which of these three packs
   * of mince is this?" is unanswerable from the words `Beef mince` and trivial
   * from a thumbnail. Released when the draft is saved, discarded or replaced.
   *
   * A cache-directory URI, so the OS may reclaim it under storage pressure. A
   * missing file degrades to a card with no thumbnail, never to a broken draft.
   */
  imageUri?: string;
  /**
   * The editor's starting state, once there is one.
   *
   * Present for `ready` and normally for `failed` too — a failure still
   * produces a prefill carrying its notice. Absent only if the runner itself
   * threw, which it is written not to do; the caller falls back to a blank
   * manual prefill so even that case stays reviewable.
   */
  prefill?: AddScreenPrefill;
}

/** Everything needed to send one scan, handed over at the shutter. */
export interface ScanJob {
  scanId: string;
  /** Released the moment the request settles — see `settle`. */
  imageBase64: string;
  /**
   * Where that image lives on disk. Outlives the request; see `PendingScan`.
   *
   * Separate from `imageBase64` on purpose: the string is the upload and is
   * dropped as soon as it has been sent, while the file is the draft's identity
   * and is kept until the draft goes.
   */
  imageUri: string;
  capture: CaptureTimings;
}

/** What the runner reports back. Already mapped to editor state by `queue.ts`. */
export interface ScanOutcome {
  ok: boolean;
  prefill: AddScreenPrefill;
}

/**
 * The network half, injected.
 *
 * `queuedMs` is passed in rather than measured downstream because only the
 * queue knows it, and it must stay distinguishable from time actually spent on
 * the wire — a scan that waited two seconds for a slot did not take two seconds
 * longer to upload, and a log line that conflated the two would send the next
 * person optimising the wrong stage.
 */
export type ScanRunner = (
  job: ScanJob & { queuedMs: number },
) => Promise<ScanOutcome>;

export interface ScanQueue {
  /** Enqueue a captured photo. Returns immediately; the camera never waits. */
  add(job: ScanJob): void;
  /**
   * Retake: this photo belongs to an existing draft and supersedes it.
   *
   * One draft in, one draft out — which is the whole of the bug this fixes.
   * Retake used to leave the original in place while the new photo enqueued
   * itself under a fresh id, so one physical pack became two rows.
   *
   * The new scan carries its own `scanId`, because it is a different photograph
   * and the id is what ties a request to its two log lines; reusing the old one
   * would make two different photos indistinguishable in the logs. What it
   * inherits is the original's `shutterAt`, so the card stays where it was in
   * the strip instead of jumping to the end for having been retaken.
   *
   * Falls back to a plain `add` when the previous draft is already gone — saved
   * or discarded from another screen while the camera was open. A retake should
   * never be lost because the thing it was replacing disappeared first.
   */
  replace(previousScanId: string, job: ScanJob): void;
  /** Forget a scan — saved, or discarded by hand. Idempotent. */
  remove(scanId: string): void;
  get(scanId: string): PendingScan | undefined;
  /** Stable reference between mutations, as `useSyncExternalStore` requires. */
  snapshot(): readonly PendingScan[];
  subscribe(listener: () => void): () => void;
  counts(): ScanCounts;
}

export interface ScanCounts {
  /** Queued or in flight. Nothing to look at yet. */
  checking: number;
  /** Finished, either way, and waiting on the user. */
  toReview: number;
}

export function createScanQueue(options: {
  run: ScanRunner;
  /**
   * Called with a retained image URI once nothing refers to it any more.
   *
   * Injected for the same reason `run` is: this file has no value imports, so
   * the offline suite can load it under Node's type stripping. Deleting a file
   * is the wiring's job, not the state machine's — and routing every release
   * through one hook is what stops a future caller forgetting one and leaving a
   * photograph behind in the cache directory.
   */
  onRelease?: (imageUri: string) => void;
  /**
   * The clock, so `settledAt` is orderable under test.
   *
   * Three results can land inside one millisecond, and `Date.now()` then makes
   * "which came back last" a coin toss — fine on a device, useless in a test
   * that has to state the answer. Injected for the same reason `run` is, and
   * production simply takes the default.
   */
  now?: () => number;
  cap?: number;
}): ScanQueue {
  const { run, onRelease, now = Date.now, cap = MAX_ACTIVE } = options;

  const scans = new Map<string, PendingScan>();
  /**
   * Jobs held separately from the scans they belong to, so the base64 payload
   * can be dropped the instant a request settles while the reviewable draft
   * stays. Otherwise ten finished scans would sit on ten photos' worth of
   * string for as long as the user took to review them.
   */
  const jobs = new Map<string, { job: ScanJob; queuedAt: number }>();
  const waiting: string[] = [];
  const listeners = new Set<() => void>();

  let active = 0;
  let snapshot: readonly PendingScan[] = [];

  function publish(): void {
    // Rebuilt on mutation rather than on read: `useSyncExternalStore` compares
    // snapshots by reference and re-renders forever if a fresh array comes back
    // every time it asks.
    snapshot = [...scans.values()].sort((a, b) => a.shutterAt - b.shutterAt);
    for (const listener of listeners) listener();
  }

  /**
   * Start whatever the cap now allows. Never notifies.
   *
   * Publishing is left to the caller so that one thing happening — a shutter
   * press, a request settling — produces exactly one notification, rather than
   * one for the state change and another for the scan it started. Every entry
   * point below therefore ends in a single `publish()`.
   */
  function pump(): void {
    while (active < cap && waiting.length > 0) {
      const scanId = waiting.shift() as string;
      const entry = jobs.get(scanId);
      const scan = scans.get(scanId);

      // Discarded while it sat in the queue. Drop it without spending a slot.
      if (!entry || !scan) {
        jobs.delete(scanId);
        continue;
      }

      active += 1;
      scans.set(scanId, { ...scan, status: 'active' });
      // Runs synchronously as far as its first `await`, so the request is on
      // the wire before this returns.
      void start(scanId, entry.job, entry.queuedAt);
    }
  }

  async function start(
    scanId: string,
    job: ScanJob,
    queuedAt: number,
  ): Promise<void> {
    const queuedMs = Math.max(0, now() - queuedAt);
    let outcome: ScanOutcome | null = null;

    try {
      outcome = await run({ ...job, queuedMs });
    } catch {
      // The runner is written never to throw — every failure is already a typed
      // outcome. This is the belt: a slot released here regardless is what stops
      // one unexpected throw wedging the queue for the rest of the session, and
      // the scan still settles into a reviewable state rather than vanishing.
      outcome = null;
    } finally {
      active -= 1;
      // The payload goes here and not a moment later. Otherwise a run of scans
      // reviewed but not yet saved would hold a photograph's worth of base64
      // each, for as long as the person took to look at them.
      jobs.delete(scanId);
      settle(scanId, outcome);
      pump();
      publish();
    }
  }

  /**
   * Record a job and start it if there is room. Never notifies — see `pump`.
   *
   * `shutterAt` is a parameter rather than read off the job because a retake
   * inherits the original's, which is the only thing keeping its card from
   * jumping to the end of the strip.
   */
  function enqueue(job: ScanJob, shutterAt: number): void {
    scans.set(job.scanId, {
      scanId: job.scanId,
      status: 'queued',
      shutterAt,
      imageUri: job.imageUri,
    });
    jobs.set(job.scanId, { job, queuedAt: now() });
    waiting.push(job.scanId);
    pump();
  }

  function settle(scanId: string, outcome: ScanOutcome | null): void {
    const scan = scans.get(scanId);

    // Discarded while the request was in the air. The result is dropped on
    // purpose: the user has already said they do not want this one, and
    // re-adding it because the network finally answered would be a small
    // betrayal of that.
    if (!scan) return;

    scans.set(scanId, {
      ...scan,
      status: outcome?.ok ? 'ready' : 'failed',
      settledAt: now(),
      prefill: outcome?.prefill,
    });
  }

  /**
   * Drop a scan and hand back whatever file it was holding. Not published.
   *
   * The single place a retained image stops being referenced, so it is the
   * single place the file can be deleted. `remove` and `replace` both go
   * through it rather than each remembering to release.
   */
  function forget(scanId: string): boolean {
    const scan = scans.get(scanId);
    const had = scans.delete(scanId);
    jobs.delete(scanId);
    if (scan?.imageUri && onRelease) onRelease(scan.imageUri);
    return had;
  }

  return {
    add(job) {
      // The same id twice would mean two records of one photo. Can't happen —
      // ids are minted per shutter press — but the guard costs nothing and the
      // failure it prevents is a duplicate item in someone's list.
      if (scans.has(job.scanId)) return;

      enqueue(job, job.capture.shutterAt);
      publish();
    },

    replace(previousScanId, job) {
      // Inherited before the old record goes, so the retake keeps its place in
      // the strip. Falling back to this shutter covers the draft that was
      // already saved or discarded from another screen — see the interface note.
      const previous = scans.get(previousScanId);
      const shutterAt = previous?.shutterAt ?? job.capture.shutterAt;

      // Order matters. The old record goes first so that its slot, its file and
      // any late result belonging to it are all released before the new one
      // takes its place — and `settle` already drops a result whose scan has
      // gone, so an in-flight original cannot resurrect itself here.
      forget(previousScanId);
      enqueue(job, shutterAt);
      publish();
    },

    remove(scanId) {
      // `waiting` is left alone; `pump` skips ids with no job. Splicing it here
      // would be the same outcome with an extra way to get the indices wrong.
      if (forget(scanId)) publish();
    },

    get: (scanId) => scans.get(scanId),
    snapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    counts() {
      let checking = 0;
      let toReview = 0;
      for (const scan of scans.values()) {
        if (scan.status === 'queued' || scan.status === 'active') checking += 1;
        else toReview += 1;
      }
      return { checking, toReview };
    },
  };
}

/**
 * How one pending scan reads on Home.
 *
 * Here rather than in the component so the offline suite can hold it to the
 * response contract, for the same reason `reviewCopy` lives in `mapping.ts`.
 * The two are deliberately consistent: a row that says the date is missing must
 * open an editor that says the same thing.
 *
 * The branch order matters and repeats a bug already fixed once in
 * `reviewCopy`. A scan that returned *neither* field is the same situation as an
 * outright failure — a well-formed answer saying nothing was legible — and has
 * to be tested before the single-field cases, each of which promises that the
 * other field came back. Checked in the wrong order, an empty read renders as
 * "We got the date" beside no date at all.
 *
 * `tappable` is false only while there is genuinely nothing to look at. Every
 * terminal state opens the editor, including the failures: that is what keeps a
 * bad photo a thing you finish by hand rather than a thing you lose.
 */
export function pendingSummary(scan: PendingScan): {
  title: string;
  note: string;
  tappable: boolean;
} {
  if (scan.status === 'queued' || scan.status === 'active') {
    return { title: 'Checking…', note: '', tappable: false };
  }

  const prefill = scan.prefill;
  const hasName = Boolean(prefill?.name);
  const hasDate = prefill?.expiryDate != null;

  if (scan.status === 'failed' || !prefill || (!hasName && !hasDate)) {
    return {
      title: "Couldn't read that one",
      note: 'Tap to type it in',
      tappable: true,
    };
  }

  if (!hasName) {
    return { title: 'Ready to review', note: 'Name it and save', tappable: true };
  }
  if (!hasDate) {
    return { title: prefill.name, note: 'Add the date', tappable: true };
  }
  return { title: prefill.name, note: 'Ready to review', tappable: true };
}

/**
 * The one-line summary the camera shows while work is outstanding.
 *
 * Counts only. No percentage, no stage sequence, no estimate — nothing here
 * knows how long the model will take, and the accepted design forbids inventing
 * a number to fill the gap. How many are checking and how many are waiting on
 * you is the whole of what is true.
 */
export function countsLine(counts: ScanCounts): string | null {
  const parts: string[] = [];
  if (counts.checking > 0) parts.push(`${counts.checking} checking`);
  if (counts.toReview > 0) parts.push(`${counts.toReview} to review`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** True once a scan has an answer to show, whichever way it went. */
export function isSettled(scan: PendingScan): boolean {
  return scan.status === 'ready' || scan.status === 'failed';
}

/**
 * The one settled scan the camera should be showing, if any.
 *
 * Deliberately one card and not a list. The camera's job is to photograph the
 * next thing; a growing stack of results there would compete with the shutter
 * and eventually become the screen. Home already holds every outstanding draft,
 * and that is where a list belongs.
 *
 * Ordered by `settledAt`, not `shutterAt`. Three requests in flight finish in
 * whatever order the network and the model decide, and the card is answering
 * "what just came back" — ordering by shutter would show the second item's
 * result while the third one's was the news.
 *
 * `dismissed` is ids the user has waved away on this screen. Purely a view
 * concern: the draft itself is untouched and still on Home, so dismissing costs
 * nothing and the card needs no confirmation. Kept as a parameter rather than
 * as queue state because it is about what one screen is showing, not about what
 * the scan *is*.
 *
 * `since` is when the camera opened. The card is for results arriving *while
 * you watch* — greeting someone with the answer to something they photographed
 * five minutes ago, the moment they open the camera to shoot something else,
 * would be a stale interruption rather than news. Drafts from earlier are not
 * lost by this: they are on Home, which is where a list of outstanding work
 * belongs. A scan started on an earlier visit that settles during this one is
 * still shown, which is correct — it did just come back.
 */
export function latestSettled(
  scans: readonly PendingScan[],
  dismissed: ReadonlySet<string>,
  since = 0,
): PendingScan | null {
  let best: PendingScan | null = null;

  for (const scan of scans) {
    if (!isSettled(scan) || dismissed.has(scan.scanId)) continue;
    const settledAt = scan.settledAt ?? 0;
    if (settledAt < since) continue;
    if (best === null || settledAt > (best.settledAt ?? 0)) best = scan;
  }

  return best;
}

/**
 * How a settled scan reads on the camera card.
 *
 * The point of the card is recognition, not review: `Beef mince · 3 Sep` beside
 * the photograph, while the pack is still in reach. So the item leads and the
 * date follows it on one line, which is the opposite emphasis from the editor
 * and deliberately so.
 *
 * `formatDate` is injected rather than imported. This module has no value
 * imports — that is what lets the offline suite load it under Node's type
 * stripping — and date formatting lives in `presentation.ts`, which pulls in
 * `date-fns`. Passing the formatter keeps the composition here where it can be
 * tested against exact strings, and keeps the import out.
 *
 * Branch order repeats the rule `pendingSummary` and `reviewCopy` already
 * follow: a scan that read *neither* field is the same situation as a failure
 * and has to be tested before the single-field cases, each of which promises
 * the other field came back.
 */
export function cameraResultLine(
  scan: PendingScan,
  formatDate: (iso: string) => string,
): { title: string; detail: string; tone: 'ready' | 'attention' } {
  const prefill = scan.prefill;
  const name = prefill?.name ?? '';
  const date = prefill?.expiryDate ?? null;

  if (scan.status === 'failed' || !prefill || (name.length === 0 && date === null)) {
    return {
      title: "Couldn't read that one",
      detail: 'Tap to type it in',
      tone: 'attention',
    };
  }

  if (name.length === 0) {
    return { title: formatDate(date as string), detail: 'Tap to name it', tone: 'attention' };
  }

  if (date === null) {
    return { title: name, detail: 'Tap to add the date', tone: 'attention' };
  }

  return { title: name, detail: formatDate(date), tone: 'ready' };
}
