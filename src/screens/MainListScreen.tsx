import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { UseByItem, RootStackParamList } from '../types';
import { DerivedItem } from '../domain/items/types';
import { getDerivedItems, removeItem } from '../domain/items/service';
import ItemCard from '../components/ItemCard';
import { colours } from '../components/colours';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Main'>;

/**
 * The urgency-sorted list.
 *
 * Ported from since-fresh's MainListScreen. That version wrapped the list in
 * per-category SectionList groups, ordering sections by their most urgent
 * item. Categories are gone, so this is a flat FlatList and sortItems()
 * urgency order alone decides what surfaces at the top — which is the whole
 * point of the screen for a food app.
 */
export default function MainListScreen() {
  const navigation = useNavigation<Nav>();
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

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor={colours.background} />
        <View style={styles.emptyContainer}>
          <Text style={styles.appTitle}>UseBy</Text>
          <Text style={styles.appTagline}>Nothing goes off unnoticed</Text>
          <Text style={styles.appSupport}>
            Add what's in the fridge and we'll put whatever needs eating first at the top.
          </Text>

          <View style={styles.ctaRow}>
            <TouchableOpacity
              style={styles.primaryCTA}
              onPress={() => navigation.navigate('Add')}
            >
              <Text style={styles.primaryCTAText}>Add an item</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryCTA}
              onPress={() => navigation.navigate('Capture')}
            >
              <Text style={styles.secondaryCTAText}>📷 Capture</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={colours.background} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>UseBy</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => navigation.navigate('Capture')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Capture a use-by date"
            accessibilityRole="button"
          >
            <Text style={styles.scanBtnText}>📷</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => navigation.navigate('Add')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Add an item"
            accessibilityRole="button"
          >
            <Text style={styles.addBtnText}>＋</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList<DerivedItem>
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ItemCard item={item} onMarkUsed={handleRemove} onDelete={handleRemove} />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colours.background,
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    paddingHorizontal: 32,
    paddingTop: 80,
  },
  appTitle: {
    fontSize: 42,
    fontWeight: '700',
    color: colours.textPrimary,
    letterSpacing: -1,
    marginBottom: 6,
  },
  appTagline: {
    fontSize: 20,
    fontWeight: '400',
    color: colours.textPrimary,
    marginBottom: 16,
  },
  appSupport: {
    fontSize: 15,
    color: colours.textSecondary,
    lineHeight: 22,
    marginBottom: 40,
  },
  ctaRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryCTA: {
    backgroundColor: colours.textPrimary,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  primaryCTAText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryCTA: {
    backgroundColor: colours.surface,
    borderWidth: 1,
    borderColor: colours.border,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  secondaryCTAText: {
    color: colours.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },

  // List header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colours.textPrimary,
    letterSpacing: -0.5,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  scanBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colours.surface,
    borderWidth: 1,
    borderColor: colours.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanBtnText: {
    fontSize: 16,
  },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colours.textPrimary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addBtnText: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 22,
    marginTop: -1,
  },

  list: {
    paddingBottom: 32,
  },
});
