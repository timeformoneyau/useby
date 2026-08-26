import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colours, fonts } from '../theme';

/**
 * The wait while the proxy and the model read the label.
 *
 * What this replaces: a static sage square and a line of text. It compiled, it
 * said the right thing, and on a real phone it read as a frozen app for the
 * several seconds a scan actually takes — long enough that the screen has to
 * look alive rather than merely correct.
 *
 * Two rules from the accepted design shape it. *Calm household utility* rules
 * out anything that reads as scanner theatre — no sweeping laser line, no
 * bounding boxes, no percentage. And "represent uncertainty instead of
 * inventing certainty" rules out a progress bar: nothing here knows how long
 * the model will take, so a bar that filled at a made-up rate would be a lie
 * told in the interface. What is honest is *something is happening*, and that
 * is all this claims.
 *
 * So: the mark breathes, and the ellipsis after the copy is real rather than
 * typographic. One idea, two small motions, both slow.
 */

/** One full inhale-and-out. Slow enough to read as calm rather than as a pulse. */
const BREATH_MS = 1600;
const DOT_MS = 1200;
const DOT_STAGGER_MS = 200;

export default function ReadingIndicator() {
  const breath = useRef(new Animated.Value(0)).current;
  const dotA = useRef(new Animated.Value(0)).current;
  const dotB = useRef(new Animated.Value(0)).current;
  const dotC = useRef(new Animated.Value(0)).current;

  /**
   * Honour the system's reduce-motion setting.
   *
   * A looping animation is exactly what that setting exists to suppress, and
   * this one runs for the whole wait with no way to dismiss it. When it is on,
   * everything settles at full opacity and holds — still legible, still says
   * the same thing, simply not moving.
   */
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      // Park everything at its resting-but-visible end rather than mid-fade.
      for (const value of [breath, dotA, dotB, dotC]) value.setValue(1);
      return;
    }

    const pulse = (value: Animated.Value, duration: number, delay = 0) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: 1,
            duration: duration / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: duration / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );

    // Opacity and transform only, so every one of these runs on the native
    // driver and keeps moving even while JS is busy parsing the response.
    const animations = [
      pulse(breath, BREATH_MS),
      pulse(dotA, DOT_MS),
      pulse(dotB, DOT_MS, DOT_STAGGER_MS),
      pulse(dotC, DOT_MS, DOT_STAGGER_MS * 2),
    ];
    for (const animation of animations) animation.start();

    return () => {
      for (const animation of animations) animation.stop();
    };
  }, [reduceMotion, breath, dotA, dotB, dotC]);

  const markStyle = {
    opacity: breath.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
    transform: [
      { scale: breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.09] }) },
    ],
  };

  const dotStyle = (value: Animated.Value) => ({
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }),
  });

  return (
    <View style={styles.shell}>
      <Animated.View style={[styles.mark, markStyle]} />

      <View style={styles.caption}>
        <Text style={styles.text}>Reading the label</Text>
        {/* A real ellipsis, so the copy itself is part of what is moving. */}
        <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no">
          <Animated.View style={[styles.dot, dotStyle(dotA)]} />
          <Animated.View style={[styles.dot, dotStyle(dotB)]} />
          <Animated.View style={[styles.dot, dotStyle(dotC)]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { alignItems: 'center', gap: 20 },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 14,
    // The one asymmetric corner is the app's mark; it survives the animation.
    borderBottomLeftRadius: 4,
    backgroundColor: colours.sage,
  },
  caption: { flexDirection: 'row', alignItems: 'center' },
  text: {
    fontSize: 14.5,
    fontFamily: fonts.regular,
    color: colours.cameraText,
  },
  dots: { flexDirection: 'row', alignItems: 'flex-end', marginLeft: 3, marginBottom: 2 },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    marginLeft: 2,
    backgroundColor: colours.cameraText,
  },
});
