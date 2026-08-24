import React, { useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  PanResponder,
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
 * Detail screen that carries Used / Threw it out / Delete. That screen is Phase
 * 4 work and does not exist yet, so removal stays on the swipe it already had,
 * widened to offer Used alongside Delete. Without it there would be no way to
 * take anything off the list. When Detail arrives this can become a plain tap
 * target and the swipe can go back to being a shortcut rather than the only
 * route, which is what the accepted design asks for.
 */
export default function ItemCard({ item, onMarkUsed, onDelete, isFirst }: Props) {
  const status = computeItemStatus(item);
  const { daysUntilDue, dueDate } = status;

  const isHot = daysUntilDue <= 0;
  const hero = heroText(daysUntilDue);
  const subtitle = rowSubtitle(item.dateType, dueDate, daysUntilDue);

  const barColour = isHot
    ? colours.barHot
    : daysUntilDue <= 3
      ? colours.barSoon
      : colours.barLater;

  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -REVEAL_WIDTH));
      },
      onPanResponderRelease: (_, g) => {
        Animated.spring(translateX, {
          toValue: g.dx < -SWIPE_THRESHOLD ? -REVEAL_WIDTH : 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  function closeSwipe() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
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
        accessibilityLabel={`${item.name}, ${hero}, ${subtitle}`}
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

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: hit.row,
    paddingRight: 12,
    backgroundColor: colours.card,
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
