// 사장님 정책 (2026-05-22 UX 슬로건 "이쁨"): SummaryReview polling 중 사용자에게
// 시스템 상태 ("AI 분석 중") 텍스트 노출 X. 대신 영맨 여자 비서 캐릭터 (사장님
// 직접 작성한 일러스트, GoogleApp/loding.png) 가 책상에서 펜으로 서류 작성 중인
// PNG + 살짝 bobbing + 미세 좌우 회전 (펜 쓰는 듯한 어깨 흔들림) + ✨ 별 3개
// staggered fade + 이미지 밑 로딩바 (indeterminate slide loop).
//
// 캐릭터 PNG = RN bundle 내장 (assets/loading-secretary.png, 투명 배경 알파 정상).
// 외부 호스팅 의존 X. PNG 한 장으로 진짜 펜 끝 움직임은 표현 불가능하지만,
// 캐릭터 전체의 미세 움직임 + 반짝이는 별 + 로딩바 로 "열심히 쓰고 있는" 분위기.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

const SECRETARY_PNG = require('./assets/loading-secretary.png');

interface LoadingSecretaryProps {
  /** 캐릭터 PNG 표시 크기 (정사각형). 기본 110 (사장님 2026-05-22 PM: 50% 축소). */
  size?: number;
  /** 사장님 정책 (2026-05-22 PM 2차): X 버튼은 LoadingSecretary 내부가 아닌
   *  카드 우상단으로 이동 (caller 가 absolute 직접 배치). 본 컴포넌트는 캐릭터
   *  애니메이션 + 별 + 로딩바만. */
}

export const LoadingSecretary: React.FC<LoadingSecretaryProps> = ({ size = 110 }) => {
  const bob = useRef(new Animated.Value(0)).current;
  const tilt = useRef(new Animated.Value(0)).current;
  const star1 = useRef(new Animated.Value(0)).current;
  const star2 = useRef(new Animated.Value(0)).current;
  const star3 = useRef(new Animated.Value(0)).current;
  const barSlide = useRef(new Animated.Value(0)).current;

  // 로딩바 트랙 너비 — 이미지 width 와 어울리게.
  const barTrackWidth = Math.max(size + 40, 160);
  const barIndicatorWidth = Math.round(barTrackWidth * 0.35);

  useEffect(() => {
    // bobbing — 살짝 위아래 (2px). 살아있는 듯한 느낌. (크기 줄어든 만큼 진폭 축소)
    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(bob, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    // tilt — 펜 쓰는 듯한 미세 좌우 회전 (-0.8도 ↔ +0.8도).
    const tiltLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(tilt, {
          toValue: 1,
          duration: 350,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(tilt, {
          toValue: -1,
          duration: 350,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    // 별 3개 staggered fade in/out.
    const makeStarLoop = (anim: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.delay(600),
        ]),
      );

    // 로딩바 — Material indeterminate 스타일. 인디케이터가 좌에서 우로 슬라이드 loop.
    const barLoop = Animated.loop(
      Animated.timing(barSlide, {
        toValue: 1,
        duration: 1400,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    );

    bobLoop.start();
    tiltLoop.start();
    const s1 = makeStarLoop(star1, 0);
    const s2 = makeStarLoop(star2, 500);
    const s3 = makeStarLoop(star3, 1000);
    s1.start();
    s2.start();
    s3.start();
    barLoop.start();

    return () => {
      bobLoop.stop();
      tiltLoop.stop();
      s1.stop();
      s2.stop();
      s3.stop();
      barLoop.stop();
    };
  }, [bob, tilt, star1, star2, star3, barSlide]);

  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -2] });
  const rotate = tilt.interpolate({
    inputRange: [-1, 1],
    outputRange: ['-0.8deg', '0.8deg'],
  });
  const star1Scale = star1.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const star2Scale = star2.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const star3Scale = star3.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const barTranslateX = barSlide.interpolate({
    inputRange: [0, 1],
    outputRange: [-barIndicatorWidth, barTrackWidth],
  });

  // 별 좌표 — 이미지 크기 비율에 맞춰 동적 배치.
  const starFontSize = Math.max(Math.round(size * 0.16), 14);

  return (
    <View style={styles.outer}>
      <View style={[styles.imageWrap, { width: size, height: size }]}>
        <Animated.Image
          source={SECRETARY_PNG}
          style={[
            styles.image,
            { width: size, height: size, transform: [{ translateY }, { rotate }] },
          ]}
          resizeMode="contain"
        />
        <Animated.Text
          style={[
            styles.star,
            { top: size * 0.05, left: size * 0.08, fontSize: starFontSize },
            { opacity: star1, transform: [{ scale: star1Scale }] },
          ]}
        >
          ✨
        </Animated.Text>
        <Animated.Text
          style={[
            styles.star,
            { top: size * 0.1, right: size * 0.1, fontSize: starFontSize },
            { opacity: star2, transform: [{ scale: star2Scale }] },
          ]}
        >
          ✨
        </Animated.Text>
        <Animated.Text
          style={[
            styles.star,
            { bottom: size * 0.2, right: size * 0.05, fontSize: starFontSize },
            { opacity: star3, transform: [{ scale: star3Scale }] },
          ]}
        >
          ✨
        </Animated.Text>
      </View>
      <View
        style={[
          styles.barTrack,
          { width: barTrackWidth, marginTop: 14 },
        ]}
      >
        <Animated.View
          style={[
            styles.barIndicator,
            {
              width: barIndicatorWidth,
              transform: [{ translateX: barTranslateX }],
            },
          ]}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  outer: {
    alignSelf: 'center',
    alignItems: 'center',
  },
  imageWrap: {
    position: 'relative',
  },
  image: {
    alignSelf: 'center',
  },
  star: {
    position: 'absolute',
  },
  barTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E5E5E5',
    overflow: 'hidden',
  },
  barIndicator: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#0066FF',
  },
});
