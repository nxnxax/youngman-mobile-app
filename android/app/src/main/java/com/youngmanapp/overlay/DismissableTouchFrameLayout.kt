package com.youngmanapp.overlay

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.widget.FrameLayout

/**
 * FrameLayout that invokes a callback on every touch event passing through it,
 * before normal dispatch. Used by the post-call overlay to reset the
 * auto-dismiss timer whenever the user is actively interacting (chip tap,
 * dropdown scroll, blank-area touch, etc.) so the modal does not vanish
 * mid-action.
 */
class DismissableTouchFrameLayout @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

  var onUserTouch: (() -> Unit)? = null

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    onUserTouch?.invoke()
    return super.dispatchTouchEvent(ev)
  }
}
