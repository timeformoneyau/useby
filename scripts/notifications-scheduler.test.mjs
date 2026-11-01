/**
 * Expiry reminder scheduling: the lifecycle, end to end, against a fake OS.
 *
 * Part one drives `scheduler.ts` with an in-memory notification store that
 * behaves like the platform's: identifiers are unique, scheduling an existing
 * identifier replaces it, and every call is counted and can be slowed down to
 * prove syncs never overlap.
 *
 * Part two runs the real item service and preference store (through
 * `support/app-loader.mjs`) with the scheduler wired to the same "items
 * changed" signal the app uses, so Save → edit date → Used/Delete → restart is
 * exercised through production code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { install } from './support/fakes.mjs';

register('./support/app-loader.mjs', import.meta.url);
const stubs = install();

const { createReminderScheduler } = await import('../src/domain/notifications/scheduler.ts');
const { DEFAULT_PREFS, reminderId } = await import('../src/domain/notifications/policy.ts');

process.env.TZ = 'Australia/Adelaide';
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime(); // 1 Nov 2026, noon local
const ON = { ...DEFAULT_PREFS, enabled: true };

function day(n) {
  const d = new Date(2026, 10, 1 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The OS, as far as reminders are concerned. */
function fakeOs({ permission = 'granted', delayMs = 0, failScheduleAfter = Infinity } = {}) {
  const pending = new Map(); // id → { fireAt, body }
  const calls = { schedule: 0, cancel: 0, list: 0 };
  let active = 0;
  let maxActive = 0;
  let scheduled = 0;
  const state = { permission };

  const slow = async (fn) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return fn();
    } finally {
      active -= 1;
    }
  };

  return {
    pending,
    calls,
    get maxActive() {
      return maxActive;
    },
    state,
    platform: {
      getPermission: async () => state.permission,
      listScheduled: () =>
        slow(() => {
          calls.list += 1;
          return [...pending].map(([id, v]) => ({ id, fireAt: v.fireAt, body: v.body }));
        }),
      schedule: (r) =>
        slow(() => {
          if (scheduled >= failScheduleAfter) throw new Error('alarm limit');
          scheduled += 1;
          calls.schedule += 1;
          pending.set(r.id, { fireAt: r.fireAt, body: r.body }); // same id replaces
        }),
      cancel: (id) =>
        slow(() => {
          calls.cancel += 1;
          pending.delete(id);
        }),
    },
  };
}

/** A scheduler over an in-memory item list and preferences. */
function harness(osOptions = {}) {
  const os = fakeOs(osOptions);
  const world = { items: [], prefs: { ...ON }, now: NOW };
  const scheduler = createReminderScheduler({
    platform: os.platform,
    loadItems: async () => world.items,
    loadPrefs: async () => world.prefs,
    now: () => world.now,
  });
  return { os, world, scheduler };
}

const ids = (os) => [...os.pending.keys()].sort();

/* ---------------------------------------------------------------------------
 * Part one: the scheduler against a fake OS.
 * ------------------------------------------------------------------------ */

test('saving an item schedules the day-before and on-the-day reminders', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  const result = await scheduler.sync('items');

  assert.equal(result.state, 'scheduled');
  assert.equal(result.pending, 2);
  assert.deepEqual(ids(os), [reminderId('milk', 'approaching'), reminderId('milk', 'due')].sort());
  const due = os.pending.get(reminderId('milk', 'due'));
  assert.equal(due.fireAt, new Date(2026, 10, 7, 9, 0).getTime());
  assert.equal(due.body, 'Your Milk reaches its Use By date today.');
});

test('syncing again changes nothing and never duplicates', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('startup');
  const before = { ...os.calls };
  for (let i = 0; i < 5; i += 1) await scheduler.sync('active');

  assert.equal(os.calls.schedule, before.schedule, 'no reschedules');
  assert.equal(os.calls.cancel, before.cancel, 'no cancels');
  assert.equal(os.pending.size, 2);
});

test('editing the Use By date replaces its reminders with the new date', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('items');

  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(3) }];
  await scheduler.sync('items');

  assert.equal(os.pending.size, 2, 'still exactly two');
  assert.equal(
    os.pending.get(reminderId('milk', 'due')).fireAt,
    new Date(2026, 10, 4, 9, 0).getTime(),
    'the old date is gone',
  );
});

test('renaming an item updates the wording of its pending reminders', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('items');
  world.items = [{ id: 'milk', name: 'Oat milk', expiryDate: day(6) }];
  await scheduler.sync('items');
  assert.equal(os.pending.get(reminderId('milk', 'due')).body, 'Your Oat milk reaches its Use By date today.');
  assert.equal(os.pending.size, 2);
});

test('Used or Delete cancels that item\'s reminders and leaves the others', async () => {
  const { os, world, scheduler } = harness();
  world.items = [
    { id: 'milk', name: 'Milk', expiryDate: day(6) },
    { id: 'ham', name: 'Ham', expiryDate: day(4) },
  ];
  await scheduler.sync('items');
  assert.equal(os.pending.size, 4);

  world.items = [{ id: 'ham', name: 'Ham', expiryDate: day(4) }];
  await scheduler.sync('items');
  assert.deepEqual(ids(os), [reminderId('ham', 'approaching'), reminderId('ham', 'due')].sort());
});

test('preference changes add, remove and move reminders', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('prefs');

  world.prefs = { ...world.prefs, overdue: true };
  await scheduler.sync('prefs');
  assert.ok(os.pending.has(reminderId('milk', 'overdue')), 'overdue opted in');
  assert.equal(os.pending.size, 3);

  world.prefs = { ...world.prefs, approaching: false };
  await scheduler.sync('prefs');
  assert.ok(!os.pending.has(reminderId('milk', 'approaching')), 'day-before switched off');
  assert.equal(os.pending.size, 2);

  world.prefs = { ...world.prefs, hour: 18, minute: 30 };
  await scheduler.sync('prefs');
  assert.equal(os.pending.get(reminderId('milk', 'due')).fireAt, new Date(2026, 10, 7, 18, 30).getTime());
  assert.equal(os.pending.size, 2);

  world.prefs = { ...world.prefs, enabled: false };
  const off = await scheduler.sync('prefs');
  assert.equal(off.state, 'off');
  assert.equal(os.pending.size, 0, 'reminders off cancels everything');
});

test('permission denied: nothing scheduled, nothing left pending, no throw', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('startup');
  assert.equal(os.pending.size, 2);

  os.state.permission = 'denied'; // withdrawn in system settings
  const result = await scheduler.sync('active');
  assert.equal(result.state, 'no-permission');
  assert.equal(os.pending.size, 0);

  os.state.permission = 'granted'; // given back
  await scheduler.sync('active');
  assert.equal(os.pending.size, 2);
});

test('never-asked permission schedules nothing either', async () => {
  const { os, world, scheduler } = harness({ permission: 'undetermined' });
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  assert.equal((await scheduler.sync('startup')).state, 'no-permission');
  assert.equal(os.pending.size, 0);
});

test('past-dated items and items without a valid date schedule nothing', async () => {
  const { os, world, scheduler } = harness();
  world.prefs = { ...ON, overdue: true };
  world.items = [
    { id: 'old', name: 'Ham', expiryDate: day(-5) },
    { id: 'yday', name: 'Soup', expiryDate: day(-1) }, // its day-after was 9:00 today, already gone
    { id: 'bad', name: 'Jam', expiryDate: 'whenever' },
  ];
  const result = await scheduler.sync('startup');
  assert.equal(result.pending, 0);
  assert.equal(os.pending.size, 0);
});

test('an item due today at noon still gets its overdue reminder tomorrow', async () => {
  const { os, world, scheduler } = harness();
  world.prefs = { ...ON, overdue: true };
  world.items = [{ id: 'chk', name: 'Chicken', expiryDate: day(0) }];
  await scheduler.sync('startup');
  assert.deepEqual(ids(os), [reminderId('chk', 'overdue')]);
});

test('restart reconciliation repairs whatever the OS was left holding', async () => {
  const { os, world } = harness();
  // Left over from a previous run: a reminder for an item since deleted, one
  // at a stale time, and someone else's notification.
  os.pending.set(reminderId('gone', 'due'), { fireAt: NOW + 1000, body: 'x' });
  os.pending.set(reminderId('milk', 'due'), { fireAt: NOW + 5, body: 'stale' });
  os.pending.set('not-ours', { fireAt: NOW + 10, body: 'other app feature' });

  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  // A brand-new scheduler, as after a cold start.
  const fresh = createReminderScheduler({
    platform: os.platform,
    loadItems: async () => world.items,
    loadPrefs: async () => world.prefs,
    now: () => world.now,
  });
  await fresh.sync('startup');

  assert.deepEqual(
    ids(os),
    ['not-ours', reminderId('milk', 'approaching'), reminderId('milk', 'due')].sort(),
  );
  assert.equal(os.pending.get(reminderId('milk', 'due')).body, 'Your Milk reaches its Use By date today.');
});

test('a time-zone change is picked up on the next sync and moves every reminder', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  await scheduler.sync('startup');
  const adelaide = os.pending.get(reminderId('milk', 'due')).fireAt;

  process.env.TZ = 'Europe/London';
  try {
    await scheduler.sync('active');
    const london = os.pending.get(reminderId('milk', 'due')).fireAt;
    assert.notEqual(london, adelaide);
    const d = new Date(london);
    assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [7, 9, 0], '9:00 in the new zone');
    assert.equal(os.pending.size, 2);
  } finally {
    process.env.TZ = 'Australia/Adelaide';
  }
});

test('the window rolls forward as time passes', async () => {
  const { os, world, scheduler } = harness();
  world.items = [{ id: 'far', name: 'Jam', expiryDate: day(60) }];
  await scheduler.sync('startup');
  assert.equal(os.pending.size, 0, 'too far ahead to hand to the OS yet');

  world.now = new Date(2026, 11, 10, 12).getTime(); // ~5 weeks later
  await scheduler.sync('active');
  assert.equal(os.pending.size, 2);
});

test('syncs never overlap; a burst collapses into at most one follow-up pass', async () => {
  const { os, world, scheduler } = harness({ delayMs: 5 });
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];

  const first = scheduler.sync('items');
  world.items = [
    { id: 'milk', name: 'Milk', expiryDate: day(6) },
    { id: 'ham', name: 'Ham', expiryDate: day(4) },
  ];
  const burst = [1, 2, 3, 4, 5].map((i) => scheduler.sync(`items-${i}`));
  await Promise.all([first, ...burst]);

  assert.equal(os.maxActive, 1, 'one OS call at a time');
  assert.equal(os.calls.list, 2, 'the first pass plus one coalesced follow-up');
  assert.equal(os.pending.size, 4, 'the follow-up saw the latest items');
});

test('a platform failure part-way is repaired by the next sync', async () => {
  const { os, world, scheduler } = harness({ failScheduleAfter: 1 });
  world.items = [{ id: 'milk', name: 'Milk', expiryDate: day(6) }];
  const failed = await scheduler.sync('items');
  assert.equal(failed.state, 'failed');
  assert.equal(os.pending.size, 1, 'half done');

  // The limit clears (another app freed alarms, or a transient error).
  os.platform.schedule = async (r) => {
    os.calls.schedule += 1;
    os.pending.set(r.id, { fireAt: r.fireAt, body: r.body });
  };
  await scheduler.sync('active');
  assert.equal(os.pending.size, 2);
});

/* ---------------------------------------------------------------------------
 * Part two: the real item service and preference store.
 * ------------------------------------------------------------------------ */

const service = await import('../src/domain/items/service.ts');
const { onItemsChanged } = await import('../src/domain/items/events.ts');
const { loadNotificationPrefs, saveNotificationPrefs } = await import(
  '../src/domain/notifications/prefsStore.ts'
);

function liveHarness() {
  stubs.asyncStorage.reset();
  stubs.fileSystem.reset();
  const os = fakeOs();
  const scheduler = createReminderScheduler({
    platform: os.platform,
    loadItems: service.getDerivedItems,
    loadPrefs: loadNotificationPrefs,
    now: () => NOW,
  });
  // The same wiring as App.tsx.
  let last = Promise.resolve();
  const stop = onItemsChanged(() => {
    last = scheduler.sync('items');
  });
  return { os, scheduler, settle: () => last, stop };
}

test('save, edit the date, then Used: reminders follow each step through the real service', async () => {
  const { os, settle, stop } = liveHarness();
  try {
    await saveNotificationPrefs({ ...ON });

    const milk = await service.createItem({ name: 'Milk', expiryDate: day(6) });
    await settle();
    assert.deepEqual(ids(os), [reminderId(milk.id, 'approaching'), reminderId(milk.id, 'due')].sort());

    await service.updateItem(milk.id, { expiryDate: day(2) });
    await settle();
    assert.equal(os.pending.size, 2);
    assert.equal(os.pending.get(reminderId(milk.id, 'due')).fireAt, new Date(2026, 10, 3, 9, 0).getTime());

    await service.removeItem(milk.id); // Used it
    await settle();
    assert.equal(os.pending.size, 0);
  } finally {
    stop();
  }
});

test('an edit that changes nothing writes nothing and schedules nothing', async () => {
  const { os, settle, stop } = liveHarness();
  try {
    await saveNotificationPrefs({ ...ON });
    const milk = await service.createItem({ name: 'Milk', expiryDate: day(6) });
    await settle();
    const calls = { ...os.calls };
    await service.updateItem(milk.id, { name: 'Milk', expiryDate: day(6) });
    await settle();
    assert.equal(os.calls.schedule, calls.schedule);
    assert.equal(os.calls.cancel, calls.cancel);
  } finally {
    stop();
  }
});

test('reminders never write to item storage', async () => {
  const { scheduler, stop } = liveHarness();
  try {
    await saveNotificationPrefs({ ...ON });
    await service.createItem({ name: 'Milk', expiryDate: day(6) });
    const itemWrites = () => stubs.asyncStorage.writes.filter((w) => w.key === '@useby_v1_items').length;
    const before = itemWrites();
    await scheduler.sync('startup');
    await scheduler.sync('active');
    assert.equal(itemWrites(), before);
  } finally {
    stop();
  }
});

test('preferences survive a restart and are kept apart from the items', async () => {
  stubs.asyncStorage.reset();
  await saveNotificationPrefs({ ...ON, overdue: true, hour: 7, minute: 30 });
  assert.deepEqual(await loadNotificationPrefs(), { ...ON, overdue: true, hour: 7, minute: 30 });
  assert.ok(!stubs.asyncStorage.data.has('@useby_v1_items'), 'no item record written');

  stubs.asyncStorage.data.set('@useby_v1_notification_prefs', 'garbage');
  assert.deepEqual(await loadNotificationPrefs(), DEFAULT_PREFS, 'corrupt prefs read as off');
});
