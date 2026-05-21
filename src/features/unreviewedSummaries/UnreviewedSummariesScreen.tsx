// 미확인 요약 화면. 사장님 정책 (2026-05-20 late, 2026-05-21 ship):
//   "어떠한 돌발상황으로 사용자가 미발견된 요약내용은 미확인 요약에 목록에
//    남아있게 해줘. 개별적으로 요약보기 할수도있고 여러개 선택해서 한번에
//    양식으로 전송하는 기능도 만들어줘. 디자인 이쁘게. 통화 전/후 모달창
//    디자인으로."
//
// 디자인 톤: PlanGateModal / OverlayService 와 동일 — 글래스 카드 + "영맨
// AI비서 ❤️" 헤더 + 부드러운 hairline + iOS 스타일 버튼.

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '../../services/api/client';
import { logError } from '../../services/logger/errorLog';
import {
  confirmUnreviewed,
  discardUnreviewed,
  listUnreviewed,
  type UnreviewedItem,
} from '../callRecording/api/unreviewed';
import type { RootStackParamList } from '../../navigation/types';

function formatRecordedAt(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}분 ${String(s).padStart(2, '0')}초`;
}

export const UnreviewedSummariesScreen: React.FC = () => {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<ReadonlyArray<UnreviewedItem>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listUnreviewed(50);
      setItems(res.items);
    } catch (e) {
      // 정상 흐름 (auth_pending) 과 일시 서버 에러 (5xx) 는 logError 안 함.
      // 5xx 는 웹팀 서버 점검 / 부하 등 일시적 — 사장님 ErrorLog 에 쌓을
      // 가치 없음 (사장님 정책 2026-05-21).
      const isAuthPending =
        e instanceof ApiError && e.code === 'auth_pending';
      const is5xx = e instanceof ApiError && e.httpStatus >= 500;
      if (!isAuthPending && !is5xx) {
        logError('UnreviewedSummaries.list', e);
      }
      // 사용자 안내용 메시지 — 5xx 는 friendly 문구, 나머진 일반 문구.
      if (is5xx) {
        setError('서버가 잠시 점검 중이에요. 잠시 후 다시 시도해주세요.');
      } else if (!isAuthPending) {
        setError('목록을 불러오지 못했어요. 새로고침해주세요.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSubmitSelected = useCallback(async () => {
    if (selected.size === 0 || confirming) return;
    setConfirming(true);
    const ids = Array.from(selected);
    let okCount = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        await confirmUnreviewed(id);
        okCount += 1;
      } catch (e) {
        failCount += 1;
        if (!(e instanceof ApiError && e.code === 'auth_pending')) {
          logError('UnreviewedSummaries.confirm', e, { jobId: id });
        }
      }
    }
    setConfirming(false);
    setSelected(new Set());
    if (okCount > 0) {
      ToastAndroid.show(
        `${okCount}건 저장 완료${failCount > 0 ? ` · ${failCount}건 실패` : ''}`,
        ToastAndroid.LONG,
      );
    } else if (failCount > 0) {
      ToastAndroid.show(`${failCount}건 저장 실패`, ToastAndroid.LONG);
    }
    await load();
  }, [selected, confirming, load]);

  /** 단일 카드 "양식 전송" 버튼 — confirmUnreviewed. */
  const onConfirmOne = useCallback(
    async (id: string) => {
      try {
        await confirmUnreviewed(id);
        ToastAndroid.show('저장 완료', ToastAndroid.SHORT);
        await load();
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'auth_pending')) {
          logError('UnreviewedSummaries.confirmOne', e, { jobId: id });
        }
        ToastAndroid.show('저장 실패', ToastAndroid.LONG);
      }
    },
    [load],
  );

  /** 선택 항목 일괄 삭제. */
  const onDeleteSelected = useCallback(() => {
    if (selected.size === 0 || deleting) return;
    Alert.alert(
      '선택한 항목 삭제',
      `${selected.size}건의 미확인 요약을 삭제할까요? 되돌릴 수 없습니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            const ids = Array.from(selected);
            let okCount = 0;
            let failCount = 0;
            for (const id of ids) {
              try {
                await discardUnreviewed(id);
                okCount += 1;
              } catch (e) {
                failCount += 1;
                logError('UnreviewedSummaries.discard', e, { jobId: id });
              }
            }
            setDeleting(false);
            setSelected(new Set());
            if (okCount > 0) {
              ToastAndroid.show(
                `${okCount}건 삭제 완료${failCount > 0 ? ` · ${failCount}건 실패` : ''}`,
                ToastAndroid.LONG,
              );
            } else if (failCount > 0) {
              ToastAndroid.show(`${failCount}건 삭제 실패`, ToastAndroid.LONG);
            }
            await load();
          },
        },
      ],
    );
  }, [selected, deleting, load]);

  const renderItem = useCallback(
    ({ item }: { item: UnreviewedItem }) => {
      const isSelected = selected.has(item.id);
      return (
        <View style={[styles.card, isSelected && styles.cardSelected]}>
          <Pressable
            onPress={() => toggleSelect(item.id)}
            style={styles.cardHeader}
            hitSlop={8}
          >
            <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
              {isSelected ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
            <Text style={styles.customerName} numberOfLines={1}>
              {item.customer_name?.trim() || '이름 없음'}
            </Text>
          </Pressable>
          <Text style={styles.meta}>
            {formatRecordedAt(item.recorded_at)} · {formatDuration(item.duration_sec)}
          </Text>
          {item.phone_number ? (
            <Text style={styles.phoneLine}>{item.phone_number}</Text>
          ) : null}
          {item.summary_preview ? (
            <Text style={styles.summaryPreview} numberOfLines={2}>
              {item.summary_preview}
            </Text>
          ) : null}
          <View style={styles.cardActions}>
            <Pressable
              onPress={() =>
                navigation.navigate('UnreviewedPreview', { jobId: item.id })
              }
              style={styles.cardActionSecondary}
              hitSlop={6}
            >
              <Text style={styles.cardActionSecondaryText}>요약보기</Text>
            </Pressable>
            <Pressable
              onPress={() => void onConfirmOne(item.id)}
              style={styles.cardActionPrimary}
              hitSlop={6}
            >
              <Text style={styles.cardActionPrimaryText}>양식 전송</Text>
            </Pressable>
          </View>
        </View>
      );
    },
    [navigation, selected, toggleSelect, onConfirmOne],
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          hitSlop={12}
        >
          <Text style={styles.backArrow}>‹</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.brandRow}>
            <Text style={styles.brand}>영맨 AI비서</Text>
            <Text style={styles.heart}> ❤️</Text>
          </View>
          <Text style={styles.headerSubtitle}>미확인 요약</Text>
        </View>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#0066FF" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>잠시 후 다시 시도해주세요</Text>
          <Text style={styles.emptyBody}>{error}</Text>
          <Pressable
            onPress={() => {
              setLoading(true);
              void load();
            }}
            style={styles.retryButton}
            hitSlop={8}
          >
            <Text style={styles.retryText}>새로고침</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>미확인 요약이 없습니다</Text>
          <Text style={styles.emptyBody}>
            통화 종료 후 AI가 요약한 결과가{'\n'}여기에 모입니다.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor="#0066FF"
            />
          }
        />
      )}

      {selected.size > 0 ? (
        <View style={styles.footerBar}>
          <View style={styles.footerRow}>
            <Pressable
              onPress={onDeleteSelected}
              disabled={deleting || confirming}
              style={[
                styles.deleteButton,
                (deleting || confirming) && styles.submitDisabled,
              ]}
            >
              {deleting ? (
                <ActivityIndicator color="#FF3B30" />
              ) : (
                <Text style={styles.deleteText}>
                  {selected.size}건 삭제
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => void onSubmitSelected()}
              disabled={confirming || deleting}
              style={[
                styles.submitButton,
                (confirming || deleting) && styles.submitDisabled,
              ]}
            >
              {confirming ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitText}>
                  {selected.size}건 양식 전송
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F7F7F8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 28, color: '#0066FF', lineHeight: 28 },
  headerCenter: { flex: 1, alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  brand: { fontSize: 15, fontWeight: '700', color: '#111111', letterSpacing: -0.2 },
  heart: { fontSize: 13 },
  headerSubtitle: { fontSize: 12, color: '#666666', marginTop: 2 },
  listContent: { padding: 12, paddingBottom: 100 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: '#0066FF', backgroundColor: '#F5F9FF' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: '#CCCCCC',
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxOn: { backgroundColor: '#0066FF', borderColor: '#0066FF' },
  checkmark: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  customerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    flex: 1,
    letterSpacing: -0.2,
  },
  meta: { fontSize: 12, color: '#888888', marginLeft: 32 },
  phoneLine: {
    fontSize: 13,
    color: '#0066FF',
    fontWeight: '600',
    marginLeft: 32,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  summaryPreview: {
    fontSize: 13,
    color: '#444444',
    lineHeight: 19,
    marginTop: 8,
    marginLeft: 32,
  },
  previewLink: { alignSelf: 'flex-start', marginTop: 10, marginLeft: 32 },
  previewLinkText: { fontSize: 13, fontWeight: '600', color: '#0066FF' },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    marginLeft: 32,
  },
  cardActionSecondary: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0066FF',
    alignItems: 'center',
  },
  cardActionSecondaryText: {
    color: '#0066FF',
    fontSize: 13,
    fontWeight: '700',
  },
  cardActionPrimary: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#0066FF',
    alignItems: 'center',
  },
  cardActionPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111111', marginBottom: 8 },
  emptyBody: { fontSize: 13, color: '#666666', textAlign: 'center', lineHeight: 19 },
  retryButton: {
    marginTop: 18,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#0066FF',
  },
  retryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', letterSpacing: -0.1 },
  footerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    paddingBottom: 24,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5E5',
  },
  footerRow: { flexDirection: 'row', gap: 8 },
  submitButton: {
    flex: 1,
    backgroundColor: '#0066FF',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  deleteButton: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#FF3B30',
  },
  deleteText: { color: '#FF3B30', fontSize: 15, fontWeight: '700' },
});
