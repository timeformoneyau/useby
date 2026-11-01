import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  SectionList,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { UseByItem, RootStackParamList } from '../types';
import { DerivedItem } from '../domain/items/types';
import { getDerivedItems, removeItem } from '../domain/items/service';
import { groupItems, headerCount } from '../domain/items/presentation';
import { emptyPrefill, failureMessage } from '../domain/scan/mapping';
import { usePendingScans } from '../domain/scan/usePendingScans';
import type { PendingScan } from '../domain/scan/pending';
import ItemCard from '../components/ItemCard';
import PendingScansStrip from '../components/PendingScansStrip';
import { colours, fonts, hit, radius } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Main'>;

/**
 * Home — what needs using next.
 *
 * Ported from since-fresh's MainListScreen, which grouped by category. That is
 * gone; the grouping here is purely urgency, and the headings are just headings
 * over one divided list rather than a navigation structure. Ordering inside a
 * group is still whatever `sortItems` decided, so the urgency ladder alone
 * decides what surfaces at the top.
 */
export default function MainListScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<DerivedItem[]>([]);

  const refresh = useCallback(async () => {
    setItems(await getDerivedItems());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  async function handleRemove(item: UseByItem) {
    await removeItem(item.id);
    refresh();
  }

  /**
   * Tap a row to open it. The swipe stays as the shortcut it was always meant
   * to be — see the gesture note in `ItemCard`.
   */
  function handleOpenItem(item: UseByItem) {
    navigation.navigate('ItemDetail', { itemId: item.id });
  }

  /**
   * Open a finished scan into the editor it was always going to end in.
   *
   * The draft is *not* retired here — only saving or an explicit discard does
   * that. Backing out of the editor has to leave the scan exactly where it was,
   * because someone who opens a draft, reads it and changes their mind has not
   * asked to throw a photograph away.
   *
   * The fallback prefill covers the one case the queue cannot produce a draft
   * for — a runner that threw outright — so even that opens a usable editor
   * instead of a blank screen or a crash.
   */
  function handleOpenScan(scan: PendingScan) {
    navigation.navigate('Add', {
      prefill: scan.prefill ?? emptyPrefill('photo', failureMessage('server')),
      scanId: scan.scanId,
    });
  }

  const pending = usePendingScans();
  const sections = groupItems(items);

  // The action bar floats over the list, so the list needs to be able to
  // scroll clear of it.
  const listBottomPadding = 138 + insets.bottom;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="dark-content" backgroundColor={colours.background} />

      <View style={styles.header}>
        <View style={styles.brand}>
          {/* The mark: a rounded tile with one square corner, as drawn on the
              artboard in CSS. No asset needed. */}
          <View style={styles.mark} />
          <Text style={styles.brandName}>UseBy</Text>
        </View>
        {items.length > 0 && (
          <Text style={styles.headerCount}>{headerCount(items)}</Text>
        )}
      </View>

      {items.length === 0 ? (
        <>
          {/* Above the empty state rather than inside it: the copy is still
              true — nothing is *tracked* yet — and a first-time scan should be
              visible while it is being read rather than swallowed by a screen
              that says there is nothing here. */}
          <View style={styles.emptyStrip}>
            <PendingScansStrip scans={pending} onOpen={handleOpenScan} />
          </View>
          <View style={styles.emptyContainer}>
            <View style={styles.emptyMark} />
            <Text style={styles.emptyTitle}>Nothing to keep an eye on yet.</Text>
            <Text style={styles.emptyBody}>
              Photograph food as you put it away and UseBy will tell you what to use
              first. A few seconds per item, no lists to keep.
            </Text>
          </View>
        </>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.list, { paddingBottom: listBottomPadding }]}
          // A list header rather than a fixed banner, so a run of drafts scrolls
          // away instead of eating the screen the list is supposed to be.
          // Passed as an element: an inline component would be a new type on
          // every render and remount the strip — restarting its animation each
          // time the list refreshed.
          ListHeaderComponent={
            <PendingScansStrip scans={pending} onOpen={handleOpenScan} />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.groupHeader}>
              <Text style={styles.groupLabel}>{section.label}</Text>
              <Text style={styles.groupCount}>{section.count}</Text>
            </View>
          )}
          renderItem={({ item, index, section }) => (
            <View
              style={[
                styles.groupCardSlice,
                index === 0 && styles.groupCardTop,
                index === section.data.length - 1 && styles.groupCardBottom,
              ]}
            >
              <ItemCard
                item={item}
                onMarkUsed={handleRemove}
                onDelete={handleRemove}
                onOpen={handleOpenItem}
                isFirst={index === 0}
              />
            </View>
          )}
        />
      )}

      {/* Scrim so rows fade out under the actions rather than colliding with them. */}
      <LinearGradient
        colors={['rgba(245,239,228,0)', colours.background]}
        locations={[0, 0.36]}
        style={[styles.actionBar, { paddingBottom: insets.bottom + 22 }]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={styles.scanBtn}
          onPress={() => navigation.navigate('Capture')}
          accessibilityLabel="Scan an item"
          accessibilityRole="button"
        >
          <View style={styles.scanGlyph} />
          <Text style={styles.scanBtnText}>Scan item</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.manualBtn}
          onPress={() => navigation.navigate('Add')}
          accessibilityLabel="Add without a photo"
          accessibilityRole="button"
        >
          <Text style={styles.manualBtnText}>Add without a photo</Text>
        </TouchableOpacity>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background },

  header: {
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: {
    width: 20,
    height: 20,
    borderRadius: 7,
    borderBottomLeftRadius: 2,
    backgroundColor: colours.sage,
  },
  brandName: {
    fontSize: 20,
    fontFamily: fonts.bold,
    letterSpacing: -0.6,
    color: colours.ink,
  },
  headerCount: { fontSize: 13, fontFamily: fonts.regular, color: colours.textSub },

  list: { paddingHorizontal: 14 },

  groupHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 18,
    paddingBottom: 6,
  },
  groupLabel: {
    fontSize: 12.5,
    fontFamily: fonts.semibold,
    letterSpacing: 0.38,
    color: colours.label,
  },
  groupCount: { fontSize: 12, fontFamily: fonts.regular, color: colours.textMuted },

  /* Each row is a slice of one group card: the border and radius live here so
     the rows stack into a single rounded container. */
  groupCardSlice: {
    backgroundColor: colours.card,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colours.cardBorder,
    overflow: 'hidden',
  },
  groupCardTop: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.group,
    borderTopRightRadius: radius.group,
  },
  groupCardBottom: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.group,
    borderBottomRightRadius: radius.group,
  },

  emptyStrip: { paddingHorizontal: 14 },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 28,
    paddingBottom: 140,
  },
  emptyMark: {
    width: 54,
    height: 54,
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    backgroundColor: colours.sageTint,
    borderWidth: 1,
    borderColor: colours.sageTintBorder,
  },
  emptyTitle: {
    fontFamily: fonts.serif,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -0.34,
    color: colours.ink,
  },
  emptyBody: {
    fontSize: 15.5,
    fontFamily: fonts.regular,
    lineHeight: 24,
    color: colours.textSecondary,
  },

  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 28,
    paddingHorizontal: 22,
    gap: 6,
  },
  scanBtn: {
    minHeight: hit.primaryButton,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    // The artboard's soft cast under the primary action. Android approximates
    // it with elevation; iOS gets the offset shadow.
    elevation: 4,
    shadowColor: colours.sage,
    shadowOpacity: 0.4,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  scanGlyph: {
    width: 17,
    height: 15,
    borderWidth: 2,
    borderColor: colours.onSage,
    borderRadius: 4,
  },
  scanBtnText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    letterSpacing: -0.17,
    color: colours.onSage,
  },
  manualBtn: {
    minHeight: hit.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualBtnText: {
    fontSize: 14.5,
    fontFamily: fonts.medium,
    color: colours.secondaryAction,
  },
});
