package com.youngmanapp.overlay

import android.util.Log
import java.util.concurrent.atomic.AtomicReference

/**
 * 사장님 정책 (2026-05-21 architecture 재설계): 통화 모달 단일 owner 보장.
 * call_id 기준으로 한 chain 만 활성. 동시에 review + autoSubmit + autoDismiss 충돌
 * 차단. 새 통화 진입 시 reset.
 *
 * Android 12+ + Samsung OneUI background 정책상 background startService 차단 →
 * 모달은 Activity 기반으로 전환. 이 controller 는 Activity ↔ Service ↔ Receiver
 * 사이의 state 동기화 단일 source.
 */
object ModalController {

  enum class State { IDLE, PRECALL, POSTCALL, REVIEW, SUBMITTING, DONE }

  private const val TAG = "ModalController"
  private val state = AtomicReference(State.IDLE)
  private val currentCallId = AtomicReference<String?>(null)

  /** 새 통화 진입 — call_id 가 다르면 state reset.
   *  같은 call_id 면 현재 state 유지 (idempotent). */
  fun begin(callId: String): Boolean {
    val prev = currentCallId.getAndSet(callId)
    if (prev != callId) {
      state.set(State.IDLE)
      Log.d(TAG, "begin new call $callId (prev=$prev) → IDLE")
      return true
    }
    return false
  }

  /** Caller 가 state 진입 권한 획득 시도. 이미 다른 chain 활성이면 false. */
  fun tryTransition(from: State, to: State): Boolean {
    val ok = state.compareAndSet(from, to)
    if (ok) {
      Log.d(TAG, "transition $from → $to")
    } else {
      Log.d(TAG, "transition $from → $to blocked, current=${state.get()}")
    }
    return ok
  }

  /** 강제 state 변경 (예: 사용자 명시 cancel). */
  fun force(next: State) {
    val prev = state.getAndSet(next)
    Log.d(TAG, "force $prev → $next")
  }

  fun current(): State = state.get()

  fun callId(): String? = currentCallId.get()

  /** 통화 종료 후 cleanup. 같은 instance 재사용 안전. */
  fun reset() {
    state.set(State.IDLE)
    currentCallId.set(null)
    Log.d(TAG, "reset")
  }
}
