/**
 * The binomial arithmetic behind the safety bar.
 *
 * The question this harness exists to answer is "is the false auto-accept rate
 * below 1 in 200?", and the trap in it is that a small clean sample looks
 * exactly like a safe one. Forty-three scans with no errors is 0% observed and
 * says almost nothing: the true rate could comfortably be 5% and still have
 * produced that run. So every rate this tool reports is paired with an exact
 * Clopper-Pearson bound, and the safety verdict is decided on the bound rather
 * than on the point estimate.
 *
 * Clopper-Pearson is chosen because it is exact and conservative — it inverts
 * the binomial CDF rather than approximating it, so its coverage is never below
 * the nominal level. The usual alternatives (Wald, Wilson) are cheaper but
 * anti-conservative near zero, which is precisely the region this whole
 * exercise lives in: Wald on 0/43 returns the interval [0, 0], which would
 * declare the bar met on no evidence at all.
 *
 * No dependencies. The incomplete beta function is implemented here rather than
 * pulled in, because it is sixty lines and the alternative is a package in a
 * repo that currently has none of its own.
 */

/** Lanczos approximation, g=7, n=9. Accurate to ~15 significant figures. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges well.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) series += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/**
 * Continued-fraction expansion for the incomplete beta (Lentz's method).
 *
 * Converges quickly for x < (a+1)/(a+b+2); `incompleteBeta` below is
 * responsible for only ever calling it in that region, using the symmetry
 * I_x(a,b) = 1 - I_{1-x}(b,a) for the other half.
 */
function betacf(a, b, x) {
  const TINY = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b) — the CDF of Beta(a, b) at x. */
export function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Inverse of the above, by bisection.
 *
 * Bisection rather than Newton because it cannot diverge and the cost is
 * irrelevant here — this runs a handful of times per analysis, not per record.
 * 200 halvings of [0,1] is well past double precision, so the answer is exact
 * to the limit of the representation and identical on every run.
 */
export function betaQuantile(p, a, b) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Two-sided exact Clopper-Pearson interval for `failures` out of `trials`.
 *
 * Reported for context. It is deliberately *not* what the safety bar is decided
 * on — see `upperBound` below.
 */
export function clopperPearsonInterval(failures, trials, confidence = 0.95) {
  if (trials <= 0) return null;
  const alpha = 1 - confidence;
  return {
    lower: failures === 0 ? 0 : betaQuantile(alpha / 2, failures, trials - failures + 1),
    upper: failures === trials ? 1 : betaQuantile(1 - alpha / 2, failures + 1, trials - failures),
  };
}

/**
 * One-sided exact Clopper-Pearson upper bound.
 *
 * This is the number the verdict turns on. The bar is one-directional — "the
 * rate is no worse than 0.5%" — and spending half the error budget on a lower
 * bound nobody asked about would make the tool report a looser upper limit than
 * the evidence actually supports.
 *
 * With zero observed failures this reduces to the closed form 1 - alpha^(1/n),
 * the exact version of the familiar "rule of three": 0 in 43 gives 6.7%, and it
 * takes 598 clean scans before the bound finally drops under 0.5%.
 */
export function clopperPearsonUpperBound(failures, trials, confidence = 0.95) {
  if (trials <= 0) return null;
  if (failures >= trials) return 1;
  return betaQuantile(confidence, failures + 1, trials - failures);
}

/**
 * How many consecutive clean observations the bar needs before it can pass.
 *
 * Inverts the zero-failure case of the bound above. Worth printing in the report
 * because "insufficient evidence" is a much more useful answer when it comes
 * with the number of scans that would settle it.
 */
export function cleanSampleSizeFor(threshold, confidence = 0.95) {
  if (!(threshold > 0) || threshold >= 1) return null;
  const alpha = 1 - confidence;
  return Math.ceil(Math.log(alpha) / Math.log(1 - threshold));
}
