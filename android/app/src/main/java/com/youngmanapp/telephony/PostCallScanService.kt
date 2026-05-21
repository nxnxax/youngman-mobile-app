package com.youngmanapp.telephony

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.media.MediaMetadataRetriever
import java.io.File
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.youngmanapp.R
import com.youngmanapp.callrecording.CallRecordingClassifier
import com.youngmanapp.callrecording.RecordingState
import com.youngmanapp.logging.ErrorLog
import com.youngmanapp.overlay.LockScreenLauncherActivity
import com.youngmanapp.overlay.OverlayService
import android.app.KeyguardManager

/**
 * Short-lived foreground service started by [CallStateReceiver] when a call
 * ends. We poll MediaStore for up to 30s looking for a newly indexed file in
 * a known call recording folder. As soon as we find one — or hit the deadline
 * — we stop ourselves.
 */
class PostCallScanService : Service() {

  // Main thread handler — service 라이프사이클 (stopForeground 등) 전용.
  private val mainHandler = Handler(Looper.getMainLooper())
  // Worker thread — fs fallback / MediaStore query / MediaMetadataRetriever
  // 등 모든 disk I/O. 사장님 2026-05-21 사례: main thread 에서 polling 돌아서
  // RN/WebView freeze + 메뉴 반응 없음. 모든 disk 작업 worker 로 분리.
  private val workerThread = HandlerThread("YkPostCallWorker").apply { start() }
  private val workerHandler = Handler(workerThread.looper)
  // Legacy alias — 일부 코드가 그대로 handler 참조. 단계적 교체 위해 유지.
  private val handler get() = workerHandler
  // 사장님 정책 (2026-05-21 도미노 재진단): "통화 후 모달 안 뜸" 보고 →
  // 5초 deadline 이 T전화 케이스에 너무 짧음. T전화 file finalize 4.5초 +
  // MediaStore 인덱싱 지연 = 5초 boundary. 30초로 늘리고 fs fallback 까지
  // 같이 작동시켜 매칭 보장. 알림은 텍스트 비움 + IMPORTANCE_MIN +
  // VISIBILITY_SECRET + DEFERRED(10초) 라 사용자 시각 노출 최소.
  private val deadlineMs = 30_000L
  // 사장님 정책 (2026-05-21): worker thread 라 50ms 도 main 영향 0. T전화
  // finalize 직후 50ms 안에 매칭. 매칭 즉시 stop 이라 CPU 영향 최소.
  private val pollIntervalMs = 50L
  private var startedAt = 0L
  private lateinit var notifier: RecordingDetectedNotifier
  /** Listens for MediaStore.Audio changes so a brand-new recording fires an
   *  immediate scan instead of waiting for the next 2-second poll tick. Cuts
   *  the typical "modal appears" latency from ~2-3s to ~200ms. */
  private var mediaObserver: ContentObserver? = null
  // 사장님 정책 (2026-05-21 근본 구조 변경): polling 만으로는 T전화 file
  // finalize 시점과 매칭 사이 latency 가 발생. FileObserver 로 통화녹음
  // 폴더의 CLOSE_WRITE 이벤트를 직접 감시 → 파일 write 완료 즉시 callback
  // → 모달 즉시. polling 보다 훨씬 빠름.
  private val fileObservers = mutableListOf<FileObserver>()
  private val observerUri: Uri =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
      } else {
        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      }

  data class FoundFile(
      val uri: String,
      val displayName: String,
      val relativePath: String,
      val dateAdded: Long,
      val duration: Long,
  )

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    notifier = RecordingDetectedNotifier(this)
    // 사장님 정책 (2026-05-21): 이전 instance 가 leak 한 stranded 알림 회수.
    // service 가 새로 시작되기 직전에 호출되므로 startForeground 가 새 알림
    // 만들기 전 깨끗한 상태 보장. 또 service 가 한 번 동작 후 종료된 잔재
    // 알림도 같이 정리.
    try {
      NotificationManagerCompat.from(this).cancel(NOTIF_ID_ONGOING)
    } catch (_: Throwable) {}
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // 사장님 정책 (2026-05-21): warm-up mode — RINGING/OFFHOOK 시점에 미리
    // service 시작해서 classloader / native init / FGS 권한 데움. 즉시
    // stopSelf. 다음 진짜 통화 종료 시 onStartCommand → polling 시작 latency 0.
    if (intent?.action == ACTION_WARMUP) {
      Log.d(TAG, "warmup mode → stopSelf immediately")
      startForeground(NOTIF_ID_ONGOING, buildOngoingNotification())
      mainHandler.post {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
          stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
          @Suppress("DEPRECATION") stopForeground(true)
        }
        stopSelf()
      }
      return START_NOT_STICKY
    }
    startedAt = System.currentTimeMillis()
    Log.d(TAG, "onStartCommand")
    startForeground(NOTIF_ID_ONGOING, buildOngoingNotification())
    registerMediaObserver()
    registerFileObservers()  // 새 구조: file create/close 이벤트 즉시 감지
    workerHandler.post(pollRunnable)
    return START_NOT_STICKY
  }

  /** 사장님 정책 (2026-05-21 근본 구조): 통화녹음 폴더의 FileObserver 등록.
   *  T전화가 파일 write 완료 (CLOSE_WRITE) 시 즉시 callback → 매칭 → 모달.
   *  polling 보다 latency 훨씬 짧음 (수 ms 수준). 폴더별 별도 observer 필요. */
  private fun registerFileObservers() {
    if (fileObservers.isNotEmpty()) return
    val externalRoot = try {
      Environment.getExternalStorageDirectory()
    } catch (_: Throwable) {
      return
    }
    for (rel in FS_FALLBACK_ROOTS) {
      val dir = File(externalRoot, rel)
      if (!dir.exists() || !dir.isDirectory) continue
      val obs = createFileObserver(dir)
      try {
        obs.startWatching()
        fileObservers.add(obs)
        Log.d(TAG, "FileObserver registered: $rel")
      } catch (e: Throwable) {
        Log.w(TAG, "FileObserver start failed: $rel", e)
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun createFileObserver(dir: File): FileObserver =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        object : FileObserver(dir, CLOSE_WRITE or MOVED_TO) {
          override fun onEvent(event: Int, path: String?) {
            handleFileEvent(dir, path)
          }
        }
      } else {
        object : FileObserver(dir.absolutePath, CLOSE_WRITE or MOVED_TO) {
          override fun onEvent(event: Int, path: String?) {
            handleFileEvent(dir, path)
          }
        }
      }

  private fun handleFileEvent(dir: File, path: String?) {
    if (path == null) return
    if (!AUDIO_EXT_REGEX.matches(path)) return
    Log.d(TAG, "FileObserver CLOSE_WRITE: $path @ ${dir.absolutePath}")
    // ContentObserver kick 과 동일 흐름 — pollRunnable 호출. fs fallback 가
    // 이 파일을 매칭 후 OverlayService.start.
    workerHandler.removeCallbacks(pollRunnable)
    workerHandler.post(pollRunnable)
  }

  private fun unregisterFileObservers() {
    for (obs in fileObservers) {
      try { obs.stopWatching() } catch (_: Throwable) {}
    }
    fileObservers.clear()
  }

  private fun registerMediaObserver() {
    if (mediaObserver != null) return
    // ContentObserver callback 도 worker thread 에서. disk I/O 가 main 에
    // 안 들어오게 보장.
    mediaObserver = object : ContentObserver(workerHandler) {
      override fun onChange(selfChange: Boolean, uri: Uri?) {
        // Run the poll immediately when MediaStore signals a change. The
        // scheduled poll will still happen later — both are idempotent.
        Log.d(TAG, "MediaStore change observed (uri=$uri) — kicking poll")
        handler.removeCallbacks(pollRunnable)
        handler.post(pollRunnable)
      }
    }
    try {
      contentResolver.registerContentObserver(observerUri, true, mediaObserver!!)
    } catch (e: Exception) {
      Log.w(TAG, "registerContentObserver failed", e)
      mediaObserver = null
    }
  }

  private fun unregisterMediaObserver() {
    val obs = mediaObserver ?: return
    try {
      contentResolver.unregisterContentObserver(obs)
    } catch (_: Exception) {}
    mediaObserver = null
  }

  /** pollRunnable 은 workerHandler 의 스레드에서 실행. disk I/O / MediaStore
   *  query / MediaMetadataRetriever 모두 worker. service 라이프사이클
   *  (stopForeground / stopSelf) + Activity 시작은 mainHandler 로 escalate. */
  private val pollRunnable =
      object : Runnable {
        override fun run() {
          try {
            val found = findNewCallRecording()
            if (found != null) {
              Log.d(TAG, "found new call recording: ${found.displayName} @ ${found.relativePath}")
              RecordingState.setBaseline(this@PostCallScanService, found.dateAdded)
              // 사장님 정책 (2026-05-21 통화 후 모달 즉시 표시):
              // mainHandler.post 거치지 않고 worker 에서 직접 호출 — startService /
              // startActivity 는 어디서든 OK (OS 가 main 에서 onStartCommand
              // 처리). KeyguardManager.isKeyguardLocked 도 system service 라
              // worker 에서 안전. main thread post latency 제거 = 모달 즉시.
              if (canDrawOverlay()) {
                val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
                val isLocked = km?.isKeyguardLocked == true
                if (isLocked) {
                  LockScreenLauncherActivity.start(this@PostCallScanService, found)
                } else {
                  OverlayService.start(this@PostCallScanService, found)
                }
              } else {
                notifier.showRecordingFound(found)
              }
              // service 라이프사이클만 main 으로 escalate.
              mainHandler.post { stopSelfSafely() }
              return
            }
            Log.d(TAG, "poll: no new file yet (elapsed=${System.currentTimeMillis() - startedAt}ms)")
          } catch (t: Throwable) {
            Log.w(TAG, "poll exception", t)
          }
          val elapsed = System.currentTimeMillis() - startedAt
          if (elapsed >= deadlineMs) {
            Log.d(TAG, "deadline reached, stopping")
            mainHandler.post { stopSelfSafely() }
          } else {
            workerHandler.postDelayed(this, pollIntervalMs)
          }
        }
      }

  /** stopForeground / stopSelf 는 main thread 에서 호출 보장. caller 가
   *  worker thread 라면 mainHandler.post 로 escalate 해야 함. */
  private fun stopSelfSafely() {
    workerHandler.removeCallbacks(pollRunnable)
    unregisterMediaObserver()
    unregisterFileObservers()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
    try {
      NotificationManagerCompat.from(this).cancel(NOTIF_ID_ONGOING)
    } catch (_: Throwable) {}
    stopSelf()
  }

  override fun onDestroy() {
    workerHandler.removeCallbacks(pollRunnable)
    unregisterMediaObserver()
    unregisterFileObservers()
    try {
      NotificationManagerCompat.from(this).cancel(NOTIF_ID_ONGOING)
    } catch (_: Throwable) {}
    try {
      workerThread.quitSafely()
    } catch (_: Throwable) {}
    super.onDestroy()
  }

  private fun findNewCallRecording(): FoundFile? {
    val baseline = RecordingState.getBaseline(this)
    Log.d(TAG, "findNewCallRecording: baseline=$baseline")
    // 사장님 정책 (2026-05-21 도미노): 첫 통화도 누락 금지. baseline=0 이어도
    // fs fallback 은 진행 — 시간 윈도우 기반이라 baseline 무관.
    val skipMediaStoreQuery = (baseline == 0L)
    if (skipMediaStoreQuery) {
      val now = System.currentTimeMillis() / 1000
      RecordingState.setBaseline(this, now)
      Log.d(TAG, "no baseline — established at $now, skipping MediaStore, fs fallback only")
      return findNewCallRecordingByFileSystem(baseline)
    }

    val collection =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
          MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

    val projection =
        mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DURATION,
        )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      projection += MediaStore.Audio.Media.RELATIVE_PATH
    }

    val selection = "${MediaStore.Audio.Media.DATE_ADDED} > ?"
    val selectionArgs = arrayOf(baseline.toString())
    val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} DESC"

    var rowsSeen = 0
    var rowsAfterDuration = 0
    var rowsAfterClassifier = 0

    contentResolver
        .query(collection, projection.toTypedArray(), selection, selectionArgs, sortOrder)
        ?.use { c ->
          val idCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
          val nameCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
          val dateCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
          val durCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
          val pathCol =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
              } else -1

          while (c.moveToNext() && rowsSeen < 50) {
            rowsSeen++
            val displayName = c.getString(nameCol) ?: ""
            val relativePath = if (pathCol >= 0) c.getString(pathCol) ?: "" else ""
            val duration = c.getLong(durCol)
            // 사장님 정책 (2026-05-21): 10초 이하 통화도 모달 떠야 함 (짧은
            // 상담 / 응대 통화 누락 방지). 10000ms → 1000ms 로 단축. 알림음/
            // 벨소리는 거의 1초 이하라 그대로 skip, 1초+ 는 CallRecordingClassifier
            // 의 path/filename 검증으로 통화녹음만 통과.
            if (duration < 1_000) continue
            rowsAfterDuration++
            if (!CallRecordingClassifier.looksLikeCallRecording(relativePath, displayName)) continue
            rowsAfterClassifier++

            val id = c.getLong(idCol)
            val uri = ContentUris.withAppendedId(collection, id)
            Log.d(TAG, "match found after $rowsSeen rows: $displayName @ $relativePath")
            return FoundFile(
                uri = uri.toString(),
                displayName = displayName,
                relativePath = relativePath,
                dateAdded = c.getLong(dateCol),
                duration = duration,
            )
          }
        }
    Log.d(
        TAG,
        "no match: rowsSeen=$rowsSeen afterDuration=$rowsAfterDuration afterClassifier=$rowsAfterClassifier",
    )

    // 사장님 정책 (2026-05-21 도미노): MediaStore 가 T전화 파일 즉시 인덱싱
    // 안 함 → fs fallback 으로 /Recordings/TPhoneCallRecords/ 직접 검색.
    return findNewCallRecordingByFileSystem(baseline)
  }

  /** T전화 등 일부 dialer 가 저장하는 통화녹음 폴더를 file system 으로 직접
   *  검색. MediaStore.Audio 가 인덱싱 못 한 케이스 보강. 시간 윈도우 (직전
   *  5분) 안에 생성된 audio 파일 중 가장 최근 것 매칭. */
  private val FS_FALLBACK_ROOTS = listOf(
      "Recordings/TPhoneCallRecords",
      "Music/TPhoneCallRecords",
      "Recordings/Call",
      "Recordings/Call Recordings",
      "Call",
  )

  private val AUDIO_EXT_REGEX =
      Regex(".+\\.(m4a|amr|mp3|opus|aac|wav|3gp)$", RegexOption.IGNORE_CASE)

  private fun findNewCallRecordingByFileSystem(baseline: Long): FoundFile? {
    val externalRoot = try {
      Environment.getExternalStorageDirectory()
    } catch (e: Throwable) {
      Log.w(TAG, "getExternalStorageDirectory failed", e)
      return null
    }
    val nowSec = System.currentTimeMillis() / 1000
    val windowStartSec = nowSec - 300L  // 5분
    val lastProcessed = RecordingState.getLastProcessedPath(this)
    Log.d(
        TAG,
        "fs fallback: window $windowStartSec~$nowSec (baseline=$baseline ignored, lastProcessed=$lastProcessed)",
    )
    val candidates = mutableListOf<Pair<File, String>>()
    for (rel in FS_FALLBACK_ROOTS) {
      val dir = File(externalRoot, rel)
      if (!dir.exists() || !dir.isDirectory) continue
      val files = try { dir.listFiles() } catch (e: Throwable) { null } ?: continue
      for (f in files) {
        if (!f.isFile) continue
        if (!AUDIO_EXT_REGEX.matches(f.name)) continue
        val tsSec = f.lastModified() / 1000
        if (tsSec < windowStartSec) continue
        if (tsSec > nowSec + 60) continue
        if (lastProcessed != null && f.absolutePath == lastProcessed) continue
        if (!CallRecordingClassifier.looksLikeCallRecording("$rel/", f.name)) continue
        candidates.add(f to rel)
      }
    }
    if (candidates.isEmpty()) {
      Log.d(TAG, "fs fallback: no candidate files")
      return null
    }
    val (file, rel) = candidates.maxByOrNull { it.first.lastModified() } ?: return null
    val tsSec = file.lastModified() / 1000
    RecordingState.setLastProcessedPath(this, file.absolutePath)
    val duration = probeDurationMs(file)
    val uri = Uri.fromFile(file)
    Log.d(TAG, "fs fallback match: ${file.name} duration=$duration")
    return FoundFile(
        uri = uri.toString(),
        displayName = file.name,
        relativePath = "$rel/",
        dateAdded = tsSec,
        duration = duration,
    )
  }

  private fun probeDurationMs(file: File): Long {
    val retr = MediaMetadataRetriever()
    return try {
      retr.setDataSource(file.absolutePath)
      val raw = retr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
      raw?.toLongOrNull() ?: 0L
    } catch (e: Throwable) {
      0L
    } finally {
      try { retr.release() } catch (_: Throwable) {}
    }
  }

  private fun canDrawOverlay(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true

  private fun buildOngoingNotification(): Notification {
    ensureChannel(this, CHANNEL_ID_ONGOING, " ", NotificationManager.IMPORTANCE_MIN)
    val builder = NotificationCompat.Builder(this, CHANNEL_ID_ONGOING)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(" ")
        .setContentText(" ")
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setVisibility(NotificationCompat.VISIBILITY_SECRET)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Defer 알림 표시 — deadlineMs(5초) 안에 stop 하면 사용자 노출 0.
      builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
    }
    return builder.build()
  }

  companion object {
    private const val TAG = "PostCallScanService"
    private const val NOTIF_ID_ONGOING = 4001
    // v2 — IMPORTANCE_MIN so the status-bar icon doesn't appear during the
    // brief post-call scan. Channel importance can't be lowered after a
    // channel exists, so we ship a new channel id when the bar gets noisier
    // than the user expects.
    private const val CHANNEL_ID_ONGOING = "yk_post_call_scan_v2"

    /** Warm-up action — service / classloader / FGS 권한 미리 데움. 즉시 stopSelf.
     *  다음 진짜 통화 종료 시 onStartCommand → polling 시작 latency 0. */
    const val ACTION_WARMUP = "com.youngmanapp.action.POST_CALL_SCAN_WARMUP"

    fun start(ctx: Context) {
      val intent = Intent(ctx, PostCallScanService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    }

    /** App 시작 / 통화 시작 시점에 호출. service 의 native init / FGS 권한 /
     *  classloader 모두 미리 데움. 다음 통화 종료 시 cold start latency 0. */
    fun warmUp(ctx: Context) {
      val intent =
          Intent(ctx, PostCallScanService::class.java).setAction(ACTION_WARMUP)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
      } catch (e: Throwable) {
        Log.w(TAG, "warmUp failed", e)
      }
    }

    fun ensureChannel(ctx: Context, id: String, name: String, importance: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(id) == null) {
          val ch = NotificationChannel(id, name, importance)
          mgr.createNotificationChannel(ch)
        }
      }
    }
  }
}
