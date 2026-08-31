import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  PanResponder,
  Pressable,
} from 'react-native';
import { UseByItem } from '../types';
import { computeItemStatus } from '../utils/statusUtils';
import { heroText, rowSubtitle } from '../domain/items/presentation';
import { colours, fonts, hit } from '../theme';

interface Props {
  item: UseByItem;
  /** The item was eaten/used. */
  onMarkUsed: (item: UseByItem) => void;
  /** The item was added by mistake. */
  onDelete: (item: UseByItem) => void;
  /** Open Item Detail. */
  onOpen: (item: UseByItem) => void;
  /** Hide the divider on the first row of a group card. */
  isFirst: boolean;
}

const REVEAL_WIDTH = 152; // two 76dp actions
const SWIPE_THRESHOLD = 60;

/**
 * One row: time left, then the item, then what the pack said.
 *
 * Three columns in a fixed order, with the time-left column on a fixed rail so
 * it aligns straight down the page. The item name is the subject and takes the
 * flexible middle; the calendar date is a footnote on the right.
 *
 * The artboard has no controls on the row at all — it taps through to an Item
 * Detail screen carrying the actions. That screen now exists, so the row is a
 * tap target and the swipe is what the design always intended it to be: a
 * shortcut, not the only way to take something off the list.
 *
 * Both gestures on one row, and the arbitration is the fiddly part. The
 * pan responder only claims the gesture once the finger has travelled 8dp
 * horizontally, so a tap never reaches it and the press wins by default. The
 * one case that needs stating is a tap while the row is already swiped open:
 * that closes the row rather than navigating, because a screen arriving when
 * you meant to put the actions away is the worse surprise, and it is also how
 * every other list behaves.
 */
export default function ItemCard({
  item,
  onMarkUsed,
  onDelete,
  onOpen,
  isFirst,
}: Props) {
  const status = computeItemStatus(item);
  const { daysUntilDue, dueDate } = status;

  const isHot = daysUntilDue <= 0;
  const hero = heroText(daysUntilDue);
  const subtitle = rowSubtitle(dueDate, daysUntilDue);

  const barColour = isHot
    ? colours.barHot
    : daysUntilDue <= 3
      ? colours.barSoon
      : colours.barLater;

  const translateX = useRef(new Animated.Value(0)).current;

  /**
   * Whether the actions are showing. Mirrors the animation rather than driving
   * it — the spring owns the position; this only answers what a tap should do.
   *
   * A ref alongside the state for the same reason the editor keeps one: the tap
   * handler has to know within the tick, and a re-render is too late.
   */
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);

  function settle(toOpen: boolean) {
    openRef.current = toOpen;
    setOpen(toOpen);
    Animated.spring(translateX, {
      toValue: toOpen ? -REVEAL_WIDTH : 0,
      useNativeDriver: true,
    }).start();
  }

  const panResponder = useRef(
    PanResponder.create({
      // 8dp of horizontal travel before this claims the gesture, which is what
      // leaves an ordinary tap to the press handler underneath.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -REVEAL_WIDTH));
      },
      onPanResponderRelease: (_, g) => {
        settle(g.dx < -SWIPE_THRESHOLD);
      },
    }),
  ).current;

  function closeSwipe() {
    settle(false);
  }

  function handlePress() {
    // Put the actions away rather than navigating. Someone with a row open was
    // looking at Used and Delete; taking them to another screen instead would
    // be the wrong reading of the tap, and there would be no way to cancel.
    if (openRef.current) closeSwipe();
    else onOpen(item);
  }

  function handleDelete() {
    Alert.alert('Delete item', `Remove "${item.name}" from UseBy?`, [
      { text: 'Cancel', style: 'cancel', onPress: closeSwipe },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(item) },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.usedBtn]}
          onPress={() => onMarkUsed(item)}
          accessibilityLabel={`Mark ${item.name} used`}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>Used it</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.deleteBtn]}
          onPress={handleDelete}
          accessibilityLabel={`Delete ${item.name}`}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>Delete</Text>
        </TouchableOpacity>
      </View>

      <Animated.View
        style={[
          styles.row,
          !isFirst && styles.rowDivided,
          { transform: [{ translateX }] },
        ]}
        {...panResponder.panHandlers}
      >
        <Pressable
          style={styles.pressArea}
          onPress={handlePress}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${hero}, ${subtitle}`}
          accessibilityHint={
            open ? 'Closes the actions' : 'Opens this item'
          }
        >
          <View style={[styles.bar, { backgroundColor: barColour }]} />

          <Text
            style={[styles.hero, isHot && styles.heroHot]}
            numberOfLines={2}
          >
            {hero}
          </Text>

          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>

          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  actionsRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionBtn: { width: 76, justifyContent: 'center', alignItems: 'center' },
  usedBtn: { backgroundColor: colours.sage },
  deleteBtn: { backgroundColor: colours.destructive },
  actionText: {
    color: colours.onSage,
    fontSize: 13,
    fontFamily: fonts.semibold,
  },

  row: { backgroundColor: colours.card },
  /* The layout moved onto the pressable so the tap target is the whole row
     rather than a strip inside it. */
  pressArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: hit.row,
    paddingRight: 12,
  },
  rowDivided: {
    borderTopWidth: 1,
    borderTopColor: colours.divider,
  },
  bar: { width: 3, alignSelf: 'stretch' },

  /* Fixed rail so time-left aligns down the page. Two lines are allowed:
     "Past by 12 days" does not fit on one at this size, and the artboard's
     1.15 line-height says wrapping was expected rather than accidental. */
  hero: {
    width: 96,
    fontSize: 14.5,
    fontFamily: fonts.semibold,
    letterSpacing: -0.15,
    lineHeight: 17,
    color: colours.ink,
  },
  heroHot: { color: colours.terracotta },

  name: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontFamily: fonts.medium,
    letterSpacing: -0.24,
    color: colours.ink,
  },

  subtitle: {
    fontSize: 12.5,
    fontFamily: fonts.regular,
    color: colours.textSub,
  },
});
