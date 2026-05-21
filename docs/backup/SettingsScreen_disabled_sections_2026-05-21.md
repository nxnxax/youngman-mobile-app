# Settings 화면 임시 숨김 섹션 백업

> **일자**: 2026-05-21
> **사유**: 사장님 보고 — "모달 알림음" 과 "통화종료 후 모달 빈도" 두 설정이 실제로 작동 안 함. 작동 fix 전까지 화면에서 숨김. 사장님 정책: 나중에 고쳐서 다시 활성화.
> **복원 위치**: `src/features/settings/SettingsScreen.tsx`

## 1. 상수 (FREQUENCY 의 hint 포함)

```typescript
import type { ModalSound, PopupFrequency } from '../../services/settings/settings';

const SOUND_OPTIONS: ReadonlyArray<{ value: ModalSound; label: string }> = [
  { value: 'on', label: '알림음' },
  { value: 'off', label: '무음' },
];

const FREQUENCY_OPTIONS: ReadonlyArray<{
  value: PopupFrequency;
  label: string;
  hint?: string;
}> = [
  { value: 'always', label: '항상 (현재 동작)' },
  {
    value: 'formal',
    label: '존댓말을 사용한 통화만',
    hint: '통화 분석 후 모달이 떠서 30~60초 지연됩니다',
  },
  {
    value: 'keyword',
    label: '특정 단어 인식 시',
    hint: '아래 단어 목록 중 하나라도 통화에서 나오면 모달 표시',
  },
];
```

## 2. State + handler (keyword 입력)

```typescript
const [keywordsDraft, setKeywordsDraft] = useState<string>(
  DEFAULT_SETTINGS.keywords,
);

// 컴포넌트 마운트 effect 안에서:
setKeywordsDraft(s.keywords);
```

## 3. JSX 두 섹션

```tsx
<Section title="모달 알림음">
  {SOUND_OPTIONS.map(opt => (
    <Row
      key={opt.value}
      label={opt.label}
      selected={settings.modalSound === opt.value}
      onPress={() => patch({ modalSound: opt.value })}
    />
  ))}
</Section>

<Section
  title="통화종료 후 모달 빈도"
  footer="존댓말 / 특정 단어 옵션은 통화 분석 후 모달을 띄우므로 30~60초 정도 늦게 표시됩니다."
>
  {FREQUENCY_OPTIONS.map(opt => (
    <View key={opt.value}>
      <Row
        label={opt.label}
        hint={opt.hint}
        selected={settings.popupFrequency === opt.value}
        onPress={() => patch({ popupFrequency: opt.value })}
      />
      {settings.popupFrequency === 'keyword' &&
        opt.value === 'keyword' && (
          <View style={styles.keywordBlock}>
            <Text style={styles.keywordLabel}>
              인식할 단어 (쉼표로 구분)
            </Text>
            <TextInput
              style={styles.keywordInput}
              value={keywordsDraft}
              onChangeText={setKeywordsDraft}
              onBlur={() => patch({ keywords: keywordsDraft.trim() })}
              placeholder="사장님, 사모님"
              placeholderTextColor="#999"
            />
          </View>
        )}
    </View>
  ))}
</Section>
```

## 4. 위치

"모달 자동 닫힘 시간" 섹션과 "영맨 실시간 통화 감지" 섹션 사이.

## 5. 복원 시 체크리스트

- [ ] services/settings/settings.ts 의 ModalSound / PopupFrequency type + handler 가 실제 동작하는지 native 측 검증
- [ ] OverlayService 가 modalSound 설정 읽어 알림음 재생하는지
- [ ] CallStateReceiver / PostCallScanService 가 popupFrequency 설정 분기 처리하는지 (formal / keyword 필터링 STT 분석)
- [ ] keyword 옵션의 trigger 매커니즘 (STT 의 transcript 검색?) 구현 또는 wire-up
- [ ] 위 import 와 state 다시 추가 후 두 Section 위치에 삽입
