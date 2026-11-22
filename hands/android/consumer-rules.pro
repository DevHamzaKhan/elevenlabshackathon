# Rules for apps that include bobby-hands with minification (release builds).
# R8's optimizer produced a class that fails Android's verifier (VerifyError in the
# WebSocket server's run(), which holds monitors), so leave these packages untouched.
-keep class org.java_websocket.** { *; }
-keep class dev.bobby.hands.** { *; }
-dontwarn org.slf4j.**
