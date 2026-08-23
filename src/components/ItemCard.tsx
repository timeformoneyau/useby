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
import { computeItemStatus, secondaryLine } from '../utils/statusUtils';
import { formatDisplay } from '../utils/dateUtils';
import { colours, statusColour } from './colours';

interface Props {
  item: UseByItem;
  /** The item was eaten/used. */
  onMarkUsed: (item: UseByItem) => void;
  /** The item was added by mistake. */
  onDelete: (item: UseByItem) => void;
}

export default function ItemCard({ item, onMarkUsed, onDelete }: Props) {
  const status = computeItemStatus(item);
  const { label, dueDate } = status;
  const secondary = secondaryLine(status);
  const accent = statusColour(label);

  const translateX = useRef(new Animated.Value(0)).current;
  const SWIPE_THRESHOLD = 80;
  const REVEAL_WIDTH = 65;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) {
          translateX.setValue(Math.max(g.dx, -REVEAL_WIDTH));
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SWIPE_THRESHOLD) {
          Animated.spring(translateX, {
            toValue: -REVEAL_WIDTH,
            useNativeDriver: true,
          }).start();
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
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
      {/* Swipe actions */}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.deleteBtn]}
          onPress={handleDelete}
          accessibilityLabel={`Delete ${item.name}`}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>Delete</Text>
        </TouchableOpacity>
      </View>

      {/* Row */}
      <Animated.View
        style={[styles.row, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        {/* Left state indicator */}
        <View style={[styles.accentBar, { backgroundColor: accent }]} />

        <View style={styles.content}>
          <View style={styles.topRow}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <TouchableOpacity
              style={styles.usedBtn}
              onPress={() => onMarkUsed(item)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel={`Mark ${item.name} used`}
              accessibilityRole="button"
            >
              <Text style={styles.usedBtnText}>Used</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.dateText}>Use by {formatDisplay(dueDate)}</Text>

          <Text style={styles.statusText}>
            <Text style={{ color: accent }}>{label}</Text>
            <Text style={styles.dot}>{'  ·  '}</Text>
            <Text>{secondary}</Text>
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  actionsRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionBtn: {
    width: 65,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtn: {
    backgroundColor: colours.destructive,
  },
  actionText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    backgroundColor: colours.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colours.border,
  },
  accentBar: {
    width: 3,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 3,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: colours.textPrimary,
    flex: 1,
    marginRight: 8,
  },
  usedBtn: {
    paddingTop: 1,
  },
  usedBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: colours.textMuted,
    letterSpacing: 0.1,
  },
  dateText: {
    fontSize: 13,
    color: colours.textSecondary,
    marginBottom: 5,
  },
  statusText: {
    fontSize: 12,
    color: colours.textMuted,
  },
  dot: {
    color: colours.border,
  },
});
