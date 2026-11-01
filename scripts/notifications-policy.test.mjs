/**
 * Expiry reminder policy: dates, wording, the rolling window and the
 * reconciliation plan. Pure — no OS, no storage.
 *
 * Time zones: Node re-reads `process.env.TZ` when it changes, so each
 * zone-specific test sets it, computes, and restores it. Dates are built from
 * local calendar fields, which is the whole point being tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFS,
  ID_PREFIX,
  MAX_SCHEDULED,
  WINDOW_DAYS,
  enabledKinds,
  formatTime,
  parseCalendarDate,
  parsePrefs,
  planReminders,
  reconcilePlan,
  reminderFireTime,
  reminderId,
  reminderText,
  stepTime,
} from '../src/domain/notifications/policy.ts';

const ON = { ...DEFAULT_PREFS, enabled: true };
const HOUR = 3_600_000;

function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

/* ---------------------------------------------------------------------------
 * Defaults.
 * ------------------------------------------------------------------------ */

test('defaults: off until turned on; then the day before and the day, at 9:00 am', () => {
  assert.deepEqual(DEFAULT_PREFS, {
    enabled: false,
    approaching: true,
    due: true,
    overdue: false,
    hour: 9,
    minute: 0,
  });
  assert.deepEqual(enabledKinds(DEFAULT_PREFS), [], 'nothing until the user turns reminders on');
  assert.deepEqual(enabledKinds(ON), ['approaching', 'due']);
  assert.deepEqual(enabledKinds({ ...ON, overdue: true }), ['approaching', 'due', 'overdue']);
});

/* ---------------------------------------------------------------------------
 * Calendar dates.
 * ------------------------------------------------------------------------ */

test('the day before, the day, and the day after, at the chosen local time', () => {
  inZone('Australia/Adelaide', () => {
    assert.deepEqual(local(reminderFireTime('2026-11-12', 'approaching', ON)), [2026, 11, 11, 9, 0]);
    assert.deepEqual(local(reminderFireTime('2026-11-12', 'due', ON)), [2026, 11, 12, 9, 0]);
    assert.deepEqual(local(reminderFireTime('2026-11-12', 'overdue', ON)), [2026, 11, 13, 9, 0]);
    assert.deepEqual(
      local(reminderFireTime('2026-11-12', 'due', { hour: 18, minute: 45 })),
      [2026, 11, 12, 18, 45],
    );
  });
});

test('month, year and leap-day boundaries are calendar arithmetic', () => {
  inZone('Australia/Adelaide', () => {
    assert.deepEqual(local(reminderFireTime('2026-12-01', 'approaching', ON)).slice(0, 3), [2026, 11, 30]);
    assert.deepEqual(local(reminderFireTime('2027-01-01', 'approaching', ON)).slice(0, 3), [2026, 12, 31]);
    assert.deepEqual(local(reminderFireTime('2026-12-31', 'overdue', ON)).slice(0, 3), [2027, 1, 1]);
    assert.deepEqual(local(reminderFireTime('2028-03-01', 'approaching', ON)).slice(0, 3), [2028, 2, 29]);
    assert.deepEqual(local(reminderFireTime('2027-03-01', 'approaching', ON)).slice(0, 3), [2027, 2, 28]);
  });
});

test('across daylight saving starting, the day before is 23 hours earlier, still at 9:00', () => {
  // Adelaide: clocks go forward 2:00 → 3:00 on Sunday 4 Oct 2026.
  inZone('Australia/Adelaide', () => {
    const before = reminderFireTime('2026-10-04', 'approaching', ON); // Sat 3 Oct
    const day = reminderFireTime('2026-10-04', 'due', ON); // Sun 4 Oct
    assert.deepEqual(local(before), [2026, 10, 3, 9, 0]);
    assert.deepEqual(local(day), [2026, 10, 4, 9, 0]);
    assert.equal(day - before, 23 * HOUR, 'a calendar day, not 24 hours');
  });
});

test('across daylight saving ending, the day after is 25 hours later, still at 9:00', () => {
  // Adelaide: clocks go back 3:00 → 2:00 on Sunday 5 Apr 2026.
  inZone('Australia/Adelaide', () => {
    const day = reminderFireTime('2026-04-04', 'due', ON); // Sat 4 Apr
    const after = reminderFireTime('2026-04-04', 'overdue', ON); // Sun 5 Apr
    assert.deepEqual(local(after), [2026, 4, 5, 9, 0]);
    assert.equal(after - day, 25 * HOUR);
  });
});

test('the same rule holds in the northern hemisphere', () => {
  // New York: forward on 8 Mar 2026, back on 1 Nov 2026.
  inZone('America/New_York', () => {
    assert.equal(
      reminderFireTime('2026-03-08', 'due', ON) - reminderFireTime('2026-03-08', 'approaching', ON),
      23 * HOUR,
    );
    assert.equal(
      reminderFireTime('2026-11-01', 'due', ON) - reminderFireTime('2026-11-01', 'approaching', ON),
      25 * HOUR,
    );
  });
});

test('a reminder time inside the spring-forward gap moves later on the same day, never vanishes', () => {
  inZone('America/New_York', () => {
    const fire = reminderFireTime('2026-03-08', 'due', { hour: 2, minute: 30 });
    assert.ok(fire, 'still scheduled');
    const [y, m, d, h] = local(fire);
    assert.deepEqual([y, m, d], [2026, 3, 8]);
    assert.equal(h, 3);
  });
});

test('the same Use By date fires at 9:00 local in whichever zone the phone is in', () => {
  const adelaide = inZone('Australia/Adelaide', () => reminderFireTime('2026-11-12', 'due', ON).getTime());
  const london = inZone('Europe/London', () => reminderFireTime('2026-11-12', 'due', ON).getTime());
  assert.notEqual(adelaide, london, 'a different instant…');
  inZone('Europe/London', () => assert.deepEqual(local(new Date(london)), [2026, 11, 12, 9, 0]));
  inZone('Australia/Adelaide', () => assert.deepEqual(local(new Date(adelaide)), [2026, 11, 12, 9, 0]));
});

test('dates that are not real dates schedule nothing', () => {
  for (const bad of ['', 'soon', '2026-02-30', '2026-13-01', '26-11-12', '2026-11-12T00:00', '2026-1-5']) {
    assert.equal(parseCalendarDate(bad), null, bad);
    assert.equal(reminderFireTime(bad, 'due', ON), null, bad);
  }
});

/* ---------------------------------------------------------------------------
 * Wording.
 * ------------------------------------------------------------------------ */

test('the wording says when, in Use By language, and makes no safety claim', () => {
  assert.deepEqual(reminderText('Milk', 'approaching'), {
    title: 'UseBy',
    body: 'Your Milk reaches its Use By date tomorrow.',
  });
  assert.equal(reminderText('Milk', 'due').body, 'Your Milk reaches its Use By date today.');
  assert.equal(reminderText('Milk', 'overdue').body, 'Your Milk passed its Use By date yesterday.');

  for (const kind of ['approaching', 'due', 'overdue']) {
    const { title, body } = reminderText('Chicken thighs', kind);
    const text = `${title} ${body}`.toLowerCase();
    assert.match(body, /Use By/);
    for (const banned of ['best before', 'expir', 'safe', 'unsafe', 'throw', 'off', 'spoil', 'eat']) {
      assert.ok(!text.includes(banned), `${kind} must not say "${banned}"`);
    }
  }
});

test('a blank name still reads as a sentence', () => {
  assert.equal(reminderText('  ', 'due').body, 'Your item reaches its Use By date today.');
});

/* ---------------------------------------------------------------------------
 * Planning: which reminders exist right now.
 * ------------------------------------------------------------------------ */

function at(y, m, d, h = 12) {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

test('an item gets one reminder per enabled kind, soonest first, each with a stable id', () => {
  inZone('Australia/Adelaide', () => {
    const now = at(2026, 11, 1);
    const plan = planReminders([{ id: 'a', name: 'Milk', expiryDate: '2026-11-10' }], ON, now);
    assert.deepEqual(plan.map((p) => p.id), [reminderId('a', 'approaching'), reminderId('a', 'due')]);
    assert.ok(plan.every((p) => p.id.startsWith(ID_PREFIX)));
    assert.ok(plan[0].fireAt < plan[1].fireAt);
    assert.equal(plan[0].body, 'Your Milk reaches its Use By date tomorrow.');
  });
});

test('nothing is planned while reminders are off', () => {
  const plan = planReminders([{ id: 'a', name: 'Milk', expiryDate: '2026-11-10' }], DEFAULT_PREFS, at(2026, 11, 1));
  assert.deepEqual(plan, []);
});

test('reminders whose moment has passed are skipped; the rest of the item still counts', () => {
  inZone('Australia/Adelaide', () => {
    // Due today, and it is already noon: the day-before and 9:00 today have gone.
    const now = at(2026, 11, 10, 12);
    const prefs = { ...ON, overdue: true };
    const plan = planReminders([{ id: 'a', name: 'Milk', expiryDate: '2026-11-10' }], prefs, now);
    assert.deepEqual(plan.map((p) => p.kind), ['overdue']);

    // Long past its date: nothing at all.
    assert.deepEqual(planReminders([{ id: 'b', name: 'Ham', expiryDate: '2026-10-01' }], prefs, now), []);
  });
});

test('an item with no valid date is skipped without disturbing the others', () => {
  inZone('Australia/Adelaide', () => {
    const now = at(2026, 11, 1);
    const plan = planReminders(
      [
        { id: 'bad', name: 'X', expiryDate: 'not a date' },
        { id: 'ok', name: 'Milk', expiryDate: '2026-11-05' },
      ],
      ON,
      now,
    );
    assert.deepEqual([...new Set(plan.map((p) => p.itemId))], ['ok']);
  });
});

test('only reminders inside the rolling window are planned', () => {
  inZone('Australia/Adelaide', () => {
    const now = at(2026, 11, 1);
    const near = { id: 'near', name: 'Near', expiryDate: '2026-11-20' };
    const far = { id: 'far', name: 'Far', expiryDate: '2027-03-01' };
    const plan = planReminders([near, far], ON, now);
    assert.deepEqual([...new Set(plan.map((p) => p.itemId))], ['near']);

    // Later, once the window has rolled forward to it, the far item is planned.
    const later = planReminders([near, far], ON, at(2027, 2, 15));
    assert.ok(later.some((p) => p.itemId === 'far'));
    assert.equal(WINDOW_DAYS, 30);
  });
});

test('the cap keeps the soonest reminders and drops the furthest', () => {
  inZone('Australia/Adelaide', () => {
    const now = at(2026, 11, 1);
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `i${String(i).padStart(2, '0')}`,
      name: `Item ${i}`,
      expiryDate: `2026-11-${String(3 + (i % 25)).padStart(2, '0')}`,
    }));
    const plan = planReminders(items, ON, now);
    assert.equal(plan.length, MAX_SCHEDULED);
    const latest = Math.max(...plan.map((p) => p.fireAt));
    const all = planReminders(items, ON, now, { max: 10_000 });
    assert.ok(all.filter((p) => p.fireAt < latest).every((p) => plan.some((q) => q.id === p.id)));
  });
});

test('two records with the same id still produce one reminder per kind', () => {
  inZone('Australia/Adelaide', () => {
    const now = at(2026, 11, 1);
    const plan = planReminders(
      [
        { id: 'a', name: 'Milk', expiryDate: '2026-11-10' },
        { id: 'a', name: 'Milk', expiryDate: '2026-11-10' },
      ],
      ON,
      now,
    );
    assert.equal(plan.length, 2);
    assert.equal(new Set(plan.map((p) => p.id)).size, 2);
  });
});

/* ---------------------------------------------------------------------------
 * Reconciliation: what to change at the OS.
 * ------------------------------------------------------------------------ */

const planned = (id, fireAt, body = 'b') => ({ id, itemId: 'x', kind: 'due', fireAt, title: 'UseBy', body });
const pending = (id, fireAt, body = 'b') => ({ id, fireAt, body });

test('a reminder already pending exactly as planned is left alone', () => {
  const id = reminderId('a', 'due');
  assert.deepEqual(reconcilePlan([planned(id, 100)], [pending(id, 100)]), { cancel: [], schedule: [] });
});

test('a missing reminder is scheduled; an unwanted one is cancelled', () => {
  const keep = reminderId('a', 'due');
  const gone = reminderId('b', 'due');
  const fresh = reminderId('c', 'due');
  const { cancel, schedule } = reconcilePlan(
    [planned(keep, 1), planned(fresh, 2)],
    [pending(keep, 1), pending(gone, 3)],
  );
  assert.deepEqual(cancel, [gone]);
  assert.deepEqual(schedule.map((s) => s.id), [fresh]);
});

test('a changed time or wording replaces the reminder, never adds a second', () => {
  const id = reminderId('a', 'due');
  const moved = reconcilePlan([planned(id, 200)], [pending(id, 100)]);
  assert.deepEqual(moved.cancel, [id]);
  assert.deepEqual(moved.schedule.map((s) => s.id), [id]);

  const renamed = reconcilePlan([planned(id, 100, 'new')], [pending(id, 100, 'old')]);
  assert.deepEqual(renamed.cancel, [id]);
  assert.equal(renamed.schedule.length, 1);
});

test('notifications that are not ours are never touched', () => {
  const { cancel, schedule } = reconcilePlan([], [pending('someone-else', 1), pending('expo-xyz', 2)]);
  assert.deepEqual(cancel, []);
  assert.deepEqual(schedule, []);
});

test('if the OS somehow holds two with one id, both go and one comes back', () => {
  const id = reminderId('a', 'due');
  const { cancel, schedule } = reconcilePlan([planned(id, 100)], [pending(id, 100), pending(id, 100)]);
  assert.deepEqual(cancel, [id]);
  assert.equal(schedule.length, 1);
});

/* ---------------------------------------------------------------------------
 * Stored preferences and the time control.
 * ------------------------------------------------------------------------ */

test('stored preferences fall back to the defaults field by field', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{not json'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('"on"'), DEFAULT_PREFS);
  assert.deepEqual(
    parsePrefs(JSON.stringify({ enabled: true, overdue: true, hour: 25, minute: 'x', approaching: 'yes' })),
    { ...DEFAULT_PREFS, enabled: true, overdue: true },
  );
  assert.deepEqual(
    parsePrefs(JSON.stringify({ enabled: true, approaching: false, due: true, overdue: false, hour: 18, minute: 30 })),
    { enabled: true, approaching: false, due: true, overdue: false, hour: 18, minute: 30 },
  );
});

test('the time steps by quarter hours and wraps round midnight', () => {
  assert.deepEqual(stepTime({ hour: 9, minute: 0 }, 1), { hour: 9, minute: 15 });
  assert.deepEqual(stepTime({ hour: 9, minute: 0 }, -1), { hour: 8, minute: 45 });
  assert.deepEqual(stepTime({ hour: 23, minute: 45 }, 1), { hour: 0, minute: 0 });
  assert.deepEqual(stepTime({ hour: 0, minute: 0 }, -1), { hour: 23, minute: 45 });
  assert.deepEqual(stepTime({ hour: 9, minute: 7 }, 1), { hour: 9, minute: 15 }, 'snaps to the grid');
});

test('times read the way people say them', () => {
  assert.equal(formatTime(9, 0), '9:00 am');
  assert.equal(formatTime(12, 30), '12:30 pm');
  assert.equal(formatTime(0, 15), '12:15 am');
  assert.equal(formatTime(18, 45), '6:45 pm');
});
