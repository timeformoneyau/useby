/**
 * Reading a printed date the way a rule does, not the way a model does.
 *
 * The point of this module is the division of labour it enforces. The model is
 * asked only what it can honestly answer — *what characters are printed on the
 * pack* — and everything after that is arithmetic done here, where it can be
 * tested and where it behaves identically every time. Asking a model to be both
 * the observer and the authority on what `04/09/26` means is asking it to make a
 * judgement we can neither check nor reproduce.
 *
 * That matters most for the one error this whole exercise exists to catch. On
 * Australian packaging `04/09/26` is 4 September; read the American way it is
 * 9 April. Both are real dates, both are plausible for groceries, and the
 * difference is invisible in the normalised output — an ISO date carries no
 * record of how it was arrived at. Given the printed characters, the ambiguity
 * is a property of the string and can simply be detected.
 *
 * Nothing here is used to build what the user sees. It produces evidence for
 * the shadow trust gate and nothing else; the prefill still comes from the
 * model's own normalised date, exactly as before.
 *
 * No value imports, so Node's type stripping loads it and the whole table of
 * printed forms below is exercised offline.
 */

/** How the printed characters were laid out. Recorded for the reason histogram. */
export type DateTextFormat =
  | 'iso'
  | 'numeric-dmy'
  | 'numeric-partial'
  | 'named-month'
  | 'month-year'
  | 'unparseable';

export interface ParsedDateText {
  /** What the characters resolve to, or null if they do not resolve at all. */
  iso: string | null;
  format: DateTextFormat;
  /**
   * The string admits more than one valid reading.
   *
   * True for an all-numeric date whose first two components are both 12 or
   * less, because day-first and month-first both produce a real date and the
   * characters alone cannot say which was meant.
   */
  ambiguous: boolean;
  /** No year was printed, so any year in `iso` was supplied by the rule below. */
  yearInferred: boolean;
  /** No day was printed — a month-and-year date, which does not resolve. */
  dayMissing: boolean;
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Wording that may have been printed alongside the date and swept into the same
 * string. The model is asked for the label separately, so this is defensive —
 * but a leading `USE BY` would otherwise make an ordinary date unparseable.
 */
const LEADING_LABEL =
  /^(USE\s*-?\s*BY|BEST\s*BEFORE(\s*END)?|BBE?|EXPIRY|EXPIRES|EXP|SELL\s*BY|PACKED(\s*ON)?|BAKED(\s*ON)?)\b[:.\s]*/;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function iso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Expand a printed year to four digits.
 *
 * Two digits become `20YY`. Groceries do not carry twentieth-century dates and
 * will not reach 2100 before this code is replaced, so the pivot that a general
 * date library would agonise over is simply not a question here.
 */
function fullYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

const UNPARSEABLE: ParsedDateText = {
  iso: null,
  format: 'unparseable',
  ambiguous: false,
  yearInferred: false,
  dayMissing: false,
};

/**
 * The year to assume when none was printed.
 *
 * The nearest sensible one: this year if that date has not already passed, next
 * year otherwise — which is what a person does with `04 SEP` on a jar in
 * October. Two days of slack because a use-by date that passed yesterday is a
 * real thing to be holding.
 *
 * It is still a guess, and `yearInferred` says so. The trust gate refuses to
 * auto-accept anything that depends on it, because guessing the year wrong is
 * a twelve-month error and there is no evidence on the pack to catch it.
 */
function inferYear(today: Date, month: number, day: number): number {
  const year = today.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const floor = today.getTime() - 2 * 86_400_000;
  return candidate >= floor ? year : year + 1;
}

/**
 * Read a printed date.
 *
 * `today` is passed in rather than read from the clock so the year-inference
 * rule is testable, and so one scan's evaluation cannot straddle midnight.
 */
export function parseDateText(text: string, today: Date): ParsedDateText {
  const cleaned = text
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_LABEL, '')
    .trim();

  if (cleaned.length === 0) return UNPARSEABLE;

  // ISO, which the packaging occasionally uses and which is never ambiguous.
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cleaned);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    if (!isRealDate(y, m, d)) return UNPARSEABLE;
    return { iso: iso(y, m, d), format: 'iso', ambiguous: false, yearInferred: false, dayMissing: false };
  }

  const named = parseNamedMonth(cleaned, today);
  if (named) return named;

  return parseNumeric(cleaned, today);
}

/**
 * `04 SEP 26`, `04SEP26`, `SEP 2026`, `04 SEP`.
 *
 * A named month is the good case: it fixes which component is the month, so the
 * day-versus-month ambiguity cannot arise at all. What can still go missing is
 * the year, and — in `SEP 26` — whether the lone number is a day or a year.
 */
function parseNamedMonth(text: string, today: Date): ParsedDateText | null {
  // Deliberately no word boundary in front. Dot-matrix stamps run the parts
  // together — `04SEP26` is an ordinary thing to find on a pack — and `\b`
  // would refuse to see the month there at all. `SEPT` precedes `SEP` in the
  // alternation so the longer spelling wins where both could match.
  const match = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)/.exec(text);
  if (!match) return null;

  const month = MONTHS[match[1] === 'SEPT' ? 'SEP' : match[1]];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);

  const numbersIn = (part: string) => (part.match(/\d+/g) ?? []).map(Number);
  const lead = numbersIn(before);
  const trail = numbersIn(after);

  // Anything with more numbers than a date has is not a date we understand.
  if (lead.length > 1 || trail.length > 1) return UNPARSEABLE;

  const day = lead.length === 1 ? lead[0] : null;
  const trailing = trail.length === 1 ? trail[0] : null;
  const trailingIsYear = trailing !== null && (after.trim().length >= 4 || trailing > 31);

  // `04 SEP 26` — day printed, year printed. The unambiguous, complete case.
  if (day !== null && trailing !== null) {
    const year = fullYear(trailing);
    if (!isRealDate(year, month, day)) return UNPARSEABLE;
    return {
      iso: iso(year, month, day),
      format: 'named-month',
      ambiguous: false,
      yearInferred: false,
      dayMissing: false,
    };
  }

  // `04 SEP` — the year has to come from somewhere, and that somewhere is a rule.
  if (day !== null && trailing === null) {
    if (!isRealDate(2024, month, day)) return UNPARSEABLE; // leap-safe shape check
    const year = inferYear(today, month, day);
    if (!isRealDate(year, month, day)) return UNPARSEABLE;
    return {
      iso: iso(year, month, day),
      format: 'named-month',
      ambiguous: false,
      yearInferred: true,
      dayMissing: false,
    };
  }

  // `SEP 2026` — a month and a year. Conventionally end of month, but that is
  // an interpretation rather than a reading, so it does not resolve here.
  if (day === null && trailingIsYear) {
    return { iso: null, format: 'month-year', ambiguous: false, yearInferred: false, dayMissing: true };
  }

  // `SEP 26` — 26 September, or September 2026? The characters do not say.
  if (day === null && trailing !== null) {
    return { iso: null, format: 'named-month', ambiguous: true, yearInferred: false, dayMissing: false };
  }

  // A bare month name.
  return { iso: null, format: 'month-year', ambiguous: false, yearInferred: false, dayMissing: true };
}

/**
 * `04/09/26`, `04-09-2026`, `04.09.26`, `09/26`.
 *
 * Australian packaging is day-first, and the prompt tells the model so — but a
 * normalised ISO date carries no record of which convention produced it, which
 * is exactly why the printed characters are worth having. Here the ambiguity is
 * just a property of the numbers.
 */
function parseNumeric(text: string, today: Date): ParsedDateText {
  const parts = text.split(/[/.\-\s]+/).filter((p) => p.length > 0);
  if (!parts.every((p) => /^\d{1,4}$/.test(p))) return UNPARSEABLE;

  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number);
    const year = fullYear(c);

    const dayFirst = isRealDate(year, b, a);
    const monthFirst = isRealDate(year, a, b);

    // Both readings are real dates. This is the case the whole module exists
    // for: 4 September and 9 April are equally well-formed, and only the
    // convention separates them.
    if (dayFirst && monthFirst) {
      return {
        iso: iso(year, b, a),
        format: 'numeric-dmy',
        ambiguous: a !== b,
        yearInferred: false,
        dayMissing: false,
      };
    }

    if (dayFirst) {
      return {
        iso: iso(year, b, a),
        format: 'numeric-dmy',
        ambiguous: false,
        yearInferred: false,
        dayMissing: false,
      };
    }

    // Only the month-first reading is a real date, so the pack is not following
    // the local convention — imported packaging, or a misread. Resolvable, but
    // never on evidence this shaky.
    if (monthFirst) {
      return {
        iso: iso(year, a, b),
        format: 'numeric-dmy',
        ambiguous: true,
        yearInferred: false,
        dayMissing: false,
      };
    }

    return UNPARSEABLE;
  }

  // `09/26` — month and year, or day and month? Either way something is
  // missing and the rest would have to be guessed.
  if (parts.length === 2) {
    return { iso: null, format: 'numeric-partial', ambiguous: true, yearInferred: false, dayMissing: false };
  }

  return UNPARSEABLE;
}

/**
 * What the printed wording means, decided in code.
 *
 * The model already classifies this, and the classification is kept as a
 * cross-check — but the wording is a fixed vocabulary and matching it is a
 * rule, so the rule is what the gate trusts. `EXP` and `EXPIRY` are
 * deliberately *not* `use_by`: they are not defined terms on Australian food
 * packaging and do not say whether the date is a safety deadline or a quality
 * one, so classifying them as either would invent a claim the pack never made.
 *
 * Returns `null` when there was no wording at all, which is different from
 * wording that means nothing in particular.
 */
export function classifyDateLabel(labelText: string | null): 'use_by' | 'best_before' | 'unknown' | null {
  if (labelText === null) return null;

  const label = labelText.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (label.length === 0) return null;

  if (/\bUSE\s*BY\b/.test(label)) return 'use_by';
  if (/\bBEST\s*BEFORE\b/.test(label) || /^BBE?$/.test(label)) return 'best_before';
  return 'unknown';
}
