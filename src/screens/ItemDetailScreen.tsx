import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { DerivedItem } from '../domain/items/types';
import { getDerivedItem, removeItem } from '../domain/items/service';
import { photoStore } from '../domain/items/photoStore';
import { dateWord, heroText, longDate } from '../domain/items/presentation';
import { colours, fonts, hit, radius } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ItemDetail'>;
type DetailRoute = RouteProp<RootStackParamList, 'ItemDetail'>;

/**
 * One saved item: what it is, when it is due, what it looked like, and the two
 * ways it leaves the list.
 *
 * The fourth screen the accepted design has been waiting on. Home's rows were
 * only ever a swipe surface because there was nowhere to tap through to; now
 * there is, and the swipe goes back to being a shortcut rather than the sole
 * route to removing anything.
 *
 * The order follows Home's hierarchy so the two screens read as the same
 * product: time remaining as the hero, then the item, then its Use By date in
 * full, then the photograph, then the actions.
 *
 * **The photograph is for identification, not decoration.** It sits below the
 * text at a modest fixed height, and an item without one renders no block at
 * all — no placeholder, no "no photo" caption. An empty frame would draw the
 * eye to an absence that does not matter, and most items legitimately have none:
 * manual adds never do, and neither does anything saved before photos existed.
 *
 * The read view. Editing lives on its own screen behind the Edit action, so
 * this one stays a thing you look at rather than a form — and so a stray tap
 * while checking a date cannot change it.
 *
 * Both removal actions route through `service.removeItem`, which is the single
 * removal path and therefore the single place photo cleanup can hook.
 */
export default function ItemDetailScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<DetailRoute>();
  const insets = useSafeAreaInsets();
  const { itemId } = route.params;

  const [item, setItem] = useState<DerivedItem | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * The photo can be missing even when the item names one — the file could have
   * been lost to a failed write, or removed by something outside the app. The
   * item still renders; only the block goes.
   */
  const [photoBroken, setPhotoBroken] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      getDerivedItem(itemId).then((found) => {
        if (!active) return;
        setItem(found);
        setLoading(false);
      });
      return () => {
        active = false;
      };
    }, [itemId]),
  );

  /**
   * Guards the gap between the tap and the write, in the same tick.
   *
   * Both actions are an `await` away from navigating back, and a second press
   * landing in that gap would call `removeItem` twice. The second call is
   * harmless against storage — the item is already filtered out — but it would
   * also fire a second `goBack`, popping a screen the user wanted.
   */
  const actingRef = useRef(false);

  async function remove() {
    if (actingRef.current || !item) return;
    actingRef.current = true;

    try {
      await removeItem(item.id);
      navigation.goBack();
    } catch {
      // Let them try again rather than stranding the screen behind a dead
      // button. Home re-reads on focus either way, so nothing here can drift.
      actingRef.current = false;
    }
  }

  /**
   * "Used it" removes the item, with no confirmation.
   *
   * Matches the swipe action exactly, and deliberately so: it is the ordinary,
   * expected end of an item's life, it is what the user just did in the
   * kitchen, and a dialog asking whether they really ate it would be absurd.
   *
   * Used and Delete are the same operation today. They stay separate in the UI
   * because they *mean* different things, and recording which one happened
   * needs the Phase 3B data layer — building half of that distinction now would
   * have to be undone.
   */
  const handleUsed = remove;

  /** Delete confirms, matching the swipe. This one is a mistake being undone. */
  function handleDelete() {
    if (!item) return;
    Alert.alert('Delete item', `Remove "${item.name}" from UseBy?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: remove },
    ]);
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.gate}>
        <ActivityIndicator color={colours.sage} />
      </SafeAreaView>
    );
  }

  // Reachable rather than theoretical: the item can be removed from Home while
  // this screen sits in the back stack. Saying so and offering the way out
  // beats an empty screen or a crash.
  if (!item) {
    return (
      <SafeAreaView style={styles.gate}>
        <View style={styles.goneBody}>
          <Text style={styles.goneTitle}>That item is gone</Text>
          <Text style={styles.goneText}>It has already been used or deleted.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.primaryBtnText}>Back to list</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const { daysUntilDue, dueDate } = item.status;
  const isPast = daysUntilDue < 0;
  const photoUri = photoStore.uriFor(item.photo);
  const showPhoto = photoUri !== null && !photoBroken;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.topBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        {/*
          The recovery path, and the reason it had to exist: until now a mistake
          that reached storage could only be deleted, not corrected. Opposite
          corner from Back, matching Retake's placement on the scan editor, so
          the two screens put "change this" in the same place.
        */}
        <TouchableOpacity
          style={styles.topBtn}
          onPress={() => navigation.navigate('EditItem', { itemId: item.id })}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${item.name}`}
        >
          <Text style={styles.editText}>Edit</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 32 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.hero, isPast && styles.heroHot]}>
          {heroText(daysUntilDue)}
        </Text>

        <Text style={styles.name}>{item.name}</Text>

        {/* One concept, always Use By. What the packaging literally printed is
            still on the record and still matters internally — it just is not a
            second date idea for the reader to reconcile. See `dateWord`. */}
        <Text style={styles.dateLine}>
          {dateWord(isPast)} · {longDate(dueDate)}
        </Text>

        {showPhoto && (
          <Image
            source={{ uri: photoUri }}
            style={styles.photo}
            resizeMode="cover"
            accessibilityLabel={`Photo of ${item.name}`}
            // The file can be gone even though the item names it. Drop the
            // block rather than showing a broken frame.
            onError={() => setPhotoBroken(true)}
          />
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleUsed}
            accessibilityRole="button"
            accessibilityLabel={`Mark ${item.name} used`}
          >
            <Text style={styles.primaryBtnText}>Used it</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={handleDelete}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${item.name}`}
          >
            <Text style={styles.deleteText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colours.background },
  gate: {
    flex: 1,
    backgroundColor: colours.background,
    justifyContent: 'center',
    alignItems: 'center',
  },

  goneBody: { paddingHorizontal: 28, gap: 10, width: '100%' },
  goneTitle: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colours.ink,
  },
  goneText: {
    fontSize: 15.5,
    fontFamily: fonts.regular,
    lineHeight: 24,
    color: colours.textSecondary,
    marginBottom: 14,
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  topBtn: { paddingVertical: 12, paddingHorizontal: 10 },
  backText: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colours.secondaryAction,
  },
  editText: { fontSize: 15, fontFamily: fonts.medium, color: colours.sage },

  content: { paddingHorizontal: 24, paddingTop: 8, gap: 6 },

  hero: {
    fontFamily: fonts.serif,
    fontSize: 34,
    lineHeight: 38,
    color: colours.ink,
  },
  heroHot: { color: colours.terracotta },

  name: {
    fontSize: 21,
    fontFamily: fonts.medium,
    letterSpacing: -0.3,
    color: colours.ink,
    marginTop: 6,
  },
  dateLine: {
    fontSize: 14.5,
    fontFamily: fonts.regular,
    color: colours.textSecondary,
  },

  /* A fixed, modest height. This is here to answer "which pack was this?", not
     to be the screen — a full-bleed photo would push the date and the actions
     below the fold for no gain. */
  photo: {
    width: '100%',
    height: 200,
    borderRadius: radius.chip,
    marginTop: 18,
    backgroundColor: colours.divider,
  },

  actions: { marginTop: 28, gap: 10 },
  primaryBtn: {
    minHeight: hit.primaryButton,
    borderRadius: radius.button,
    backgroundColor: colours.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: colours.onSage,
  },
  /* Quiet, and not red. Delete is the rarer action — the item was added by
     mistake — and giving it the same weight as "Used it" would misrepresent
     which one people actually reach for. The confirmation carries the warning. */
  deleteBtn: {
    minHeight: hit.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: {
    fontSize: 15,
    fontFamily: fonts.medium,
    color: colours.destructive,
  },
});
