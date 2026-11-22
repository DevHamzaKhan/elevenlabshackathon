package dev.bobby.hands

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress

/** Token storage shared by the module (writer) and the service (reader). */
object HandsPrefs {
  private const val FILE = "bobby_hands"
  fun token(ctx: Context): String? = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("token", null)
  fun setToken(ctx: Context, token: String) {
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString("token", token).apply()
  }
}

/**
 * The hub process-wide singleton: a WebSocket server on 127.0.0.1:8765 wrapping [HubCore].
 * Started and stopped by [HandsService]. The notification listener and the Expo module reach
 * it through here.
 */
object Hub {
  const val TAG = "BobbyHands"
  const val PORT = 8765

  @Volatile var core: HubCore? = null
    private set
  @Volatile private var server: Server? = null
  @Volatile var running: Boolean = false
    private set
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var wanted = false
  private var retries = 0

  fun log(msg: String) = Log.i(TAG, msg)

  @Synchronized
  fun start(ctx: Context, toHands: (String) -> Unit) {
    wanted = true
    if (server != null) return
    val c = core ?: HubCore(HandsPrefs.token(ctx), toHands, log = { log("hub: $it") }).also { core = it }
    c.token = HandsPrefs.token(ctx)
    c.handsOn = true
    val s = Server(c)
    server = s
    try {
      s.start()
    } catch (e: Exception) {
      log("hub start failed: ${e.message}")
    }
  }

  @Synchronized
  fun stop() {
    wanted = false
    retries = 0
    core?.handsOn = false
    core?.closeAll()
    val s = server ?: return
    server = null
    running = false
    Thread {
      try { s.stop(500) } catch (_: Exception) {}
    }.start()
  }

  fun setToken(token: String) {
    core?.token = token
  }

  /** A frame from Hands itself (results, notifications). Dropped when the hub isn't up. */
  fun fromHands(text: String) {
    core?.fromHands(text)
  }

  private fun onBindFailed(ctx: () -> Unit) {
    // Another app's hub may still hold the port (e.g. right after a reinstall). Retry.
    if (!wanted || retries > 30) return
    retries++
    main.postDelayed({ ctx() }, 2000)
  }

  private class Conn(val ws: WebSocket) : HubConn {
    override fun send(text: String) {
      if (ws.isOpen) ws.send(text)
    }
    override fun close(code: Int, reason: String) {
      ws.close(code, reason)
    }
  }

  private class Server(val c: HubCore) : WebSocketServer(InetSocketAddress("127.0.0.1", PORT)) {
    init {
      isReuseAddr = true
      connectionLostTimeout = 30
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
      val wrapper = Conn(conn)
      conn.setAttachment(wrapper)
      c.onOpen(wrapper, handshake.resourceDescriptor ?: "/")
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
      conn.getAttachment<Conn>()?.let { c.onClose(it) }
    }

    override fun onMessage(conn: WebSocket, message: String) {
      conn.getAttachment<Conn>()?.let { c.onMessage(it, message) }
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
      if (conn == null) {
        log("hub server error: ${ex.message}")
        synchronized(Hub) {
          if (server === this) {
            server = null
            running = false
            onBindFailed { val ctx = HandsService.instance; if (ctx != null) start(ctx, ctx::onHandsFrame) }
          }
        }
      } else {
        log("hub socket error: ${ex.message}")
      }
    }

    override fun onStart() {
      running = true
      retries = 0
      log("hub listening on 127.0.0.1:$PORT")
    }
  }
}
