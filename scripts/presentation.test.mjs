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
  typeWord,
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

test('date type is described truthfully in both tenses', () => {
  assert.equal(typeWord('use_by', false), 'Use By');
  assert.equal(typeWord('best_before', false), 'Best Before');
  assert.equal(typeWord('unknown', false), 'Date');
  assert.equal(typeWord('use_by', true), 'Past Use By');
  assert.equal(typeWord('best_before', true), 'Best Before passed');
  assert.equal(typeWord('unknown', true), 'Date passed');
});

test('a best-before item is never described as past a safety deadline', () => {
  const past = typeWord('best_before', true);
  assert.doesNotMatch(past, /Use By/i);
  assert.equal(past, 'Best Before passed');
});

test('an item saved before dateType existed reads as unknown, not as a claim', () => {
  // v1 records have no dateType at all.
  assert.equal(typeWord(undefined, false), 'Date');
  assert.equal(typeWord(undefined, true), 'Date passed');
});

test('the row subtitle pairs what the pack said with when', () => {
  const due = new Date(2026, 7, 26);
  assert.equal(rowSubtitle('use_by', due, 2), 'Use By · 26 Aug');
  assert.equal(rowSubtitle('best_before', due, 2), 'Best Before · 26 Aug');
  assert.equal(rowSubtitle('use_by', due, -3), 'Past Use By · 26 Aug');
  assert.equal(shortDate(new Date(2026, 8, 1)), '1 Sep');
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
