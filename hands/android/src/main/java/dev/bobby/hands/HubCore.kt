package dev.bobby.hands

import org.json.JSONObject

/** One client socket, as the routing logic sees it. The transport implements this. */
interface HubConn {
  fun send(text: String)
  fun close(code: Int, reason: String)
}

/**
 * The hub's routing rules from CONTRACT.md ("Connecting", "Routing", "Watch"), with no
 * networking, so they can be unit-tested. Thread-safe: every entry point is synchronized.
 *
 * @param toHands receives every frame addressed `to: "hands"` (raw text, unchanged).
 */
class HubCore(
  @Volatile var token: String?,
  private val toHands: (String) -> Unit,
  private val clock: () -> Long = { System.currentTimeMillis() },
  private val log: (String) -> Unit = {},
) {
  /** Sees every frame the hub delivers (from, to, message). Used to caption Bobby's lines. */
  @Volatile var observer: ((String, String, JSONObject) -> Unit)? = null

  companion object {
    val ROLES = setOf("mind", "mouth", "caller", "watch")
    val SINGLE = setOf("mind", "mouth", "caller")
    const val CLOSE_REPLACED = 4001
    const val CLOSE_BAD_TOKEN = 4003

    /** Parses `/<role>?token=<t>` into (role, token). */
    fun parsePath(path: String): Pair<String, String?> {
      val noFrag = path.substringBefore('#')
      val p = noFrag.substringBefore('?').trim('/')
      val q = if (noFrag.contains('?')) noFrag.substringAfter('?') else ""
      var token: String? = null
      for (kv in q.split('&')) {
        if (kv.startsWith("token=")) token = java.net.URLDecoder.decode(kv.substring(6), "UTF-8")
      }
      return p to token
    }
  }

  private class Client(val conn: HubConn, val role: String) {
    var helloed = false
  }

  private val clients = HashMap<HubConn, Client>()
  private val current = HashMap<String, Client>() // mind/mouth/caller -> newest
  private val watches = LinkedHashSet<Client>()
  private var lastTask: JSONObject? = null
  private var lastPlan: JSONObject? = null

  /** True while the accessibility service is on. The hub only runs then, so normally true. */
  @Volatile var handsOn: Boolean = true
    set(value) { field = value; synchronized(this) { broadcastPeers() } }

  /** A socket finished its WebSocket handshake on [path]. Returns false if it was refused. */
  @Synchronized
  fun onOpen(conn: HubConn, path: String): Boolean {
    val (role, tok) = parsePath(path)
    val want = token
    if (want.isNullOrEmpty() || tok != want) {
      log("refused $role: bad token")
      conn.close(CLOSE_BAD_TOKEN, "bad token")
      return false
    }
    if (role !in ROLES) {
      log("refused unknown role '$role'")
      conn.close(CLOSE_BAD_TOKEN, "unknown role")
      return false
    }
    clients[conn] = Client(conn, role)
    return true
  }

  @Synchronized
  fun onMessage(conn: HubConn, text: String) {
    val c = clients[conn] ?: return
    val o = try { JSONObject(text) } catch (e: Exception) { return }
    if (!c.helloed) {
      if (o.optString("type") != "hello") return
      c.helloed = true
      register(c)
      return
    }
    if (o.optString("type") == "hello") return
    when (c.role) {
      "watch" -> return // read-only
      "mind" -> fromMind(o, text)
      else -> deliverToMind(c.role, o, text)
    }
  }

  @Synchronized
  fun onClose(conn: HubConn) {
    val c = clients.remove(conn) ?: return
    if (!c.helloed) return
    var changed = false
    if (c.role == "watch") {
      changed = watches.remove(c)
    } else if (current[c.role] === c) {
      current.remove(c.role)
      changed = true
    }
    if (changed) {
      log("${c.role} left")
      broadcastPeers()
    }
  }

  /** A frame produced by Hands itself (act_result, screen_result, notification). */
  @Synchronized
  fun fromHands(text: String) {
    val o = try { JSONObject(text) } catch (e: Exception) { return }
    deliverToMind("hands", o, text)
  }

  @Synchronized
  fun peers(): JSONObject = JSONObject().apply {
    put("type", "peers")
    put("hands", handsOn)
    put("mind", current.containsKey("mind"))
    put("mouth", current.containsKey("mouth"))
    put("caller", current.containsKey("caller"))
    put("watch", watches.size)
  }

  @Synchronized
  fun closeAll() {
    for (c in clients.values.toList()) try { c.conn.close(1001, "hub stopping") } catch (_: Exception) {}
    clients.clear(); current.clear(); watches.clear()
  }

  // --- internals (called with the lock held) ---

  private fun register(c: Client) {
    send(c, JSONObject().put("type", "welcome").put("v", 1).toString())
    if (c.role == "watch") {
      watches.add(c)
    } else {
      val old = current.put(c.role, c)
      if (old != null && old !== c) {
        log("${c.role} replaced; closing the older socket with 4001")
        clients.remove(old.conn)
        try { old.conn.close(CLOSE_REPLACED, "replaced") } catch (_: Exception) {}
      }
    }
    log("${c.role} joined")
    broadcastPeers()
    if (c.role == "watch") {
      val task = lastTask
      if (task != null && task.optString("status") == "started") {
        send(c, task.toString())
        lastPlan?.let { if (it.optString("task") == task.optString("task")) send(c, it.toString()) }
      }
    }
  }

  private fun fromMind(o: JSONObject, text: String) {
    when (val to = o.optString("to")) {
      "watch" -> {
        when (o.optString("type")) {
          "task" -> {
            if (lastTask?.optString("task") != o.optString("task")) lastPlan = null
            lastTask = o
          }
          "plan" -> lastPlan = o
        }
        for (w in watches.toList()) send(w, text)
      }
      "hands" -> {
        if (!handsOn) return
        mirror("mind", "hands", o)
        try { toHands(text) } catch (e: Exception) { log("hands handler failed: ${e.message}") }
      }
      "mouth", "caller" -> {
        val target = current[to] ?: return
        send(target, text)
        mirror("mind", to, o)
      }
      else -> return
    }
  }

  private fun deliverToMind(from: String, o: JSONObject, text: String) {
    val mind = current["mind"] ?: return
    // Observer first: a `heard` that unlocks the phone queues the unlock on the Hands worker
    // before the Mind can react and ask for the screen.
    mirror(from, "mind", o)
    send(mind, text)
  }

  private fun mirror(from: String, to: String, msg: JSONObject) {
    observer?.let { try { it(from, to, msg) } catch (_: Exception) {} }
    if (watches.isEmpty()) return
    val wire = JSONObject().apply {
      put("type", "wire")
      put("from", from)
      put("to", to)
      put("at", clock())
      put("msg", msg)
    }.toString()
    for (w in watches.toList()) send(w, wire)
  }

  private fun broadcastPeers() {
    val p = peers().toString()
    current["mind"]?.let { send(it, p) }
    for (w in watches.toList()) send(w, p)
  }

  private fun send(c: Client, text: String) {
    try { c.conn.send(text) } catch (e: Exception) { log("send to ${c.role} failed: ${e.message}") }
  }
}
