package dev.bobby.hands

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.fail
import java.math.BigDecimal

/** Deep JSON equality: same keys, same array order, numbers compared by value. */
fun jsonEq(a: Any?, b: Any?): Boolean = when {
  a is JSONObject && b is JSONObject ->
    a.keyNames() == b.keyNames() && a.keyNames().all { jsonEq(a.opt(it), b.opt(it)) }
  a is JSONArray && b is JSONArray ->
    a.length() == b.length() && (0 until a.length()).all { jsonEq(a.opt(it), b.opt(it)) }
  a is Number && b is Number -> BigDecimal(a.toString()).compareTo(BigDecimal(b.toString())) == 0
  else -> a == b
}

fun assertJsonEq(expected: Any?, actual: Any?) {
  if (!jsonEq(expected, actual)) fail("JSON differs\nexpected: $expected\nactual:   $actual")
}

fun assertJsonEq(expected: String, actual: String) = assertJsonEq(JSONObject(expected), JSONObject(actual))

fun j(s: String) = JSONObject(s)

/** Android's compile-time org.json has no keySet(); keys() exists in both. */
fun JSONObject.keyNames(): Set<String> = keys().asSequence().toSet()
