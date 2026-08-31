/**
 * Guards for how an item reads on screen.
 *
 * The visible grouping is deliberately coarser than the underlying urgency
 * ladder, so these tests pin both halves of that: which bucket a day-count
 * lands in, and that the row still carries the exact distance the bucket threw
 * away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupFor,
  groupItems,
  groupLabel,
  headerCount,
  heroText,
  rowSubtitle,
  shortDate,
  dateWord,
} from '../src/domain/items/presentation.ts';

const item = (id, name, daysUntilDue, dateType) => ({
  id,
  name,
  expiryDate: '2026-08-27',
  dateType,
  source: 'manual',
  createdAt: '',
  updatedAt: '',
  status: { label: 'Fresh', daysUntilDue, dueDate: new Date(2026, 7, 27) },
});

test('buckets follow the artboard boundaries', () => {
  assert.equal(groupFor(-9), 'past');
  assert.equal(groupFor(-1), 'past');
  assert.equal(groupFor(0), 'today');
  assert.equal(groupFor(1), 'soon');
  assert.equal(groupFor(3), 'soon');
  assert.equal(groupFor(4), 'later');
  assert.equal(groupFor(90), 'later');
});

test('the last bucket is "Later", not "Later this week"', () => {
  // It catches everything past three days, including items a month out, so the
  // artboard's wording would be factually wrong.
  assert.equal(groupLabel('later'), 'Later');
  assert.equal(groupFor(30), 'later');
});

test('the row keeps the precision the bucket discards', () => {
  // No separate "Well past" section, so "Past by 9 days" has to carry it.
  assert.equal(groupFor(-1), groupFor(-9), 'both are one visible group');
  assert.equal(heroText(-1), 'Past by 1 day');
  assert.equal(heroText(-9), 'Past by 9 days');
  assert.notEqual(heroText(-1), heroText(-9));
});

test('hero text reads naturally at every boundary', () => {
  assert.equal(heroText(0), 'Today');
  assert.equal(heroText(1), '1 day left');
  assert.equal(heroText(2), '2 days left');
});

test('there is one date concept, and it is Use By', () => {
  // The app used to say "Use By", "Best Before" or a bare "Date" depending on
  // what the packaging printed. Accurate, and the wrong thing to show: three
  // names for one idea, on a screen whose only job is "what do I use first?".
  assert.equal(dateWord(false), 'Use By');
  assert.equal(dateWord(true), 'Past Use By');
});

test('the consumer wording cannot depend on what the pack said', () => {
  // Structural, not a matter of copy discipline. `dateWord` takes no DateType,
  // so a later screen cannot quietly reintroduce a branch on it — which is
  // exactly how a rule kept only in wording drifts back.
  assert.equal(dateWord.length, 1, 'tense only, no date type');
});

test('no consumer wording says Best Before or Best By', () => {
  for (const isPast of [true, false]) {
    assert.doesNotMatch(dateWord(isPast), /best\s*(before|by)/i);
  }
});

test('the row subtitle pairs the date with what to call it', () => {
  const due = new Date(2026, 7, 26);
  assert.equal(rowSubtitle(due, 2), 'Use By · 26 Aug');
  assert.equal(rowSubtitle(due, -3), 'Past Use By · 26 Aug');
  assert.equal(shortDate(new Date(2026, 8, 1)), '1 Sep');
});

test('an item reads the same however its pack was labelled', () => {
  // The point of the product decision, stated as a test. A best_before item, a
  // use_by item, an unknown one and a record saved before dateType existed all
  // produce identical wording — the row cannot tell them apart, and the stored
  // classification is untouched by that.
  const due = new Date(2026, 7, 26);
  const subtitle = rowSubtitle(due, 2);
  assert.equal(subtitle, 'Use By · 26 Aug');
  assert.doesNotMatch(subtitle, /best/i);
});

test('grouping preserves the order it was given', () => {
  const items = [
    item('a', 'Coriander', -1, 'use_by'),
    item('b', 'Chicken', 0, 'use_by'),
    item('c', 'Milk', 2, 'use_by'),
    item('d', 'Yoghurt', 4, 'best_before'),
    item('e', 'Hummus', 8, 'unknown'),
  ];
  const groups = groupItems(items);
  assert.deepEqual(groups.map((g) => g.key), ['past', 'today', 'soon', 'later']);
  assert.deepEqual(groups.map((g) => g.count), [1, 1, 1, 2]);
  assert.deepEqual(groups[3].data.map((i) => i.name), ['Yoghurt', 'Hummus']);
});

test('empty groups are dropped rather than shown as bare headings', () => {
  const groups = groupItems([item('a', 'Milk', 2, 'use_by')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'soon');
});

test('an empty list produces no groups at all', () => {
  assert.deepEqual(groupItems([]), []);
});

test('the header counts what needs attention, not what is owned', () => {
  const urgent = [item('a', 'Milk', 2), item('b', 'Bread', 30)];
  assert.equal(headerCount(urgent), '1 need using soon');

  const calm = [item('a', 'Bread', 30), item('b', 'Rice', 200)];
  assert.equal(headerCount(calm), '2 tracked');
  assert.equal(headerCount([item('a', 'Rice', 200)]), '1 tracked');
});

test('past items count toward "need using soon"', () => {
  assert.equal(headerCount([item('a', 'Coriander', -4)]), '1 need using soon');
});
