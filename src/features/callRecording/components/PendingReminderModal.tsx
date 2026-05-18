import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ApiError } from '../../../services/api/client';
import {
  listPendingCustomerLogs,
  sendCustomerLogToGroup,
} from '../api/records';
import type { CustomerLogRow } from '../api/types';
import {
  markPendingReminderShown,
  shouldShowPendingReminder,
} from '../services/pendingReminder';

interface Props {
  /** Pulse this prop to make the modal re-run its check. Bump on AppState 'active'. */
  triggerKey: number;
}

function preview(row: CustomerLogRow): string {
  const name = row.customer_name?.trim() || row.phone_number || '고객';
  const summary = row.summary?.trim() || '';
  const snippet = summary.length > 28 ? summary.slice(0, 28) + '…' : summary;
  return snippet ? `${name} · ${snippet}` : name;
}

export const PendingReminderModal: React.FC<Props> = ({ triggerKey }) => {
  const [pending, setPending] = useState<ReadonlyArray<CustomerLogRow>>([]);
  const [visible, setVisible] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Always run the query so [PendingDiag] log fires even when the
        // throttle would suppress the modal — lets us diagnose what the
        // server actually returns. Modal display still respects throttle.
        const rows = await listPendingCustomerLogs();
        if (cancelled) return;
        if (!(await shouldShowPendingReminder())) {
          return;
        }
        if (rows.length === 0) {
          return;
        }
        await markPendingReminderShown();
        if (cancelled) return;
        setPending(rows);
        setVisible(true);
      } catch {
        // silent — daily reminder is best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [triggerKey]);

  const onYes = useCallback(async () => {
    setSending(true);
    try {
      // Default group (null) → server uses the user's main group / default.
      // Sequential to stay friendly to backend rate limits.
      for (const row of pending) {
        try {
          await sendCustomerLogToGroup({
            id: row.id,
            group_id: null,
          });
        } catch (e) {
          if (__DEV__) {
            const msg = e instanceof ApiError ? e.message : String(e);
            console.warn('[PendingReminder] one row failed', row.id, msg);
          }
          // keep going — partial success is better than nothing
        }
      }
    } finally {
      setSending(false);
      setVisible(false);
    }
  }, [pending]);

  const onNo = useCallback(() => {
    setVisible(false);
  }, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onNo}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.headerBlock}>
            <Text style={styles.title}>전송되지 않은 통화 요약</Text>
            <Text style={styles.message}>
              {`어제 요약하신 ${pending.length}건의 내용이${'\n'}양식 폼에 전송되지 않았습니다.`}
            </Text>
          </View>

          <ScrollView style={styles.previewList} bounces={false}>
            {pending.map(row => (
              <Text key={row.id} style={styles.previewItem} numberOfLines={1}>
                · {preview(row)}
              </Text>
            ))}
          </ScrollView>

          {sending ? (
            <View style={styles.sendingBlock}>
              <ActivityIndicator color="#0066FF" />
              <Text style={styles.sendingText}>전송 중…</Text>
            </View>
          ) : (
            <View style={styles.divider} />
          )}

          {!sending && (
            <View style={styles.buttonRow}>
              <Pressable style={styles.btn} onPress={onNo}>
                <Text style={styles.btnNo}>아니오</Text>
              </Pressable>
              <View style={styles.btnDivider} />
              <Pressable style={styles.btn} onPress={onYes}>
                <Text style={styles.btnYes}>예</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  card: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    overflow: 'hidden',
  },
  headerBlock: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    alignItems: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  message: {
    marginTop: 6,
    fontSize: 14,
    color: '#666666',
    textAlign: 'center',
    lineHeight: 20,
  },
  previewList: {
    maxHeight: 140,
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  previewItem: {
    fontSize: 13,
    color: '#444444',
    paddingVertical: 3,
  },
  divider: {
    height: 1,
    backgroundColor: '#E5E5E5',
  },
  buttonRow: {
    flexDirection: 'row',
    height: 46,
  },
  btn: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnDivider: {
    width: 1,
    backgroundColor: '#E5E5E5',
  },
  btnNo: {
    fontSize: 15,
    color: '#FF3B30',
  },
  btnYes: {
    fontSize: 15,
    color: '#0066FF',
    fontWeight: '700',
  },
  sendingBlock: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    height: 46,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#E5E5E5',
  },
  sendingText: { color: '#666', fontSize: 14 },
});
