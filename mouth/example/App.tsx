// Test app for bobby-mouth. Opening it starts the Mouth and the Caller and calls wake(),
// like the final app does. Config comes from example/.env (written by agent/setup.mjs):
//   EXPO_PUBLIC_HUB_URL=ws://10.0.2.2:8765
//   EXPO_PUBLIC_ELEVENLABS_BOBBY_AGENT_ID=...
//   EXPO_PUBLIC_HUB_TOKEN=anything      (pretend hubs accept any token)
import { useEffect, useRef, useState } from "react";
import { Button, PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { startCaller, startMouth } from "bobby-mouth";

const env = {
  ELEVENLABS_BOBBY_AGENT_ID: process.env.EXPO_PUBLIC_ELEVENLABS_BOBBY_AGENT_ID,
  CALL_ALLOWLIST: process.env.EXPO_PUBLIC_CALL_ALLOWLIST,
};
const hubUrl = process.env.EXPO_PUBLIC_HUB_URL || "ws://10.0.2.2:8765";
const token = process.env.EXPO_PUBLIC_HUB_TOKEN || "dev";

async function micGranted(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
}

export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState("idle");
  const [mic, setMic] = useState(false);
  const mouth = useRef<ReturnType<typeof startMouth> | null>(null);

  useEffect(() => {
    const log = (l: string) => {
      console.log(`[bobby-mouth] ${l}`);
      setLines((prev) => [...prev.slice(-30), l]);
    };
    const m = startMouth({ hubUrl, token, env, log });
    const c = startCaller({ hubUrl, token, env, log });
    mouth.current = m;
    micGranted().then((g) => {
      setMic(g);
      m.wake();
    });
    const t = setInterval(() => setStatus(m.status()), 300);
    return () => {
      clearInterval(t);
      m.stop();
      c.stop();
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Bobby Mouth (test app)</Text>
      <Text testID="status" style={styles.status}>{status}</Text>
      <Text style={styles.small}>hub {hubUrl} · agent {env.ELEVENLABS_BOBBY_AGENT_ID ? "set" : "MISSING"} · mic {mic ? "granted" : "not granted"}</Text>
      {!mic && (
        <Button
          title="Allow microphone"
          onPress={async () => {
            const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
            setMic(r === PermissionsAndroid.RESULTS.GRANTED);
          }}
        />
      )}
      <Button title="Wake" onPress={() => mouth.current?.wake()} />
      <ScrollView style={styles.log}>
        {lines.map((l, i) => (
          <Text key={i} style={styles.line}>{l}</Text>
        ))}
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 64, paddingHorizontal: 16, gap: 8, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "600" },
  status: { fontSize: 32, fontWeight: "700" },
  small: { color: "#555" },
  log: { flex: 1, marginTop: 8, backgroundColor: "#f4f4f4", padding: 8 },
  line: { fontFamily: Platform.OS === "android" ? "monospace" : "Menlo", fontSize: 11 },
});
