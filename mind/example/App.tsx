// bobby-mind example: proves the package runs in Expo Go.
// 1) one real model call through makeModel(), 2) startMind() connected to a hub.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { makeModel, startMind } from 'bobby-mind';

// Example app only: Expo inlines EXPO_PUBLIC_* from example/.env at bundle time.
// The package itself never reads process.env; the final app passes keys through config.env.
const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';
// The laptop's fake hub, as seen from the Android emulator.
const HUB_URL = process.env.EXPO_PUBLIC_MIND_HUB_URL || 'ws://10.0.2.2:8765';

const SCHEMA = {
  type: 'object',
  properties: { greeting: { type: 'string' }, sum: { type: 'integer' } },
  required: ['greeting', 'sum'],
  additionalProperties: false,
};

export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  const [model, setModel] = useState('model: not run');
  const [hub, setHub] = useState('hub: not started');
  const mind = useRef<{ stop(): void } | null>(null);

  const log = (line: string) => {
    console.log(line);
    setLines((l) => [...l.slice(-60), line.length > 300 ? line.slice(0, 300) + '…' : line]);
    if (line.startsWith('hub: connected')) setHub('hub: CONNECTED');
    else if (line.startsWith('hub:')) setHub(line);
  };

  const runModel = async () => {
    if (!API_KEY) {
      setModel('model: EXPO_PUBLIC_OPENAI_API_KEY missing in example/.env');
      return;
    }
    setModel('model: calling…');
    const call = makeModel({ apiKey: API_KEY, log });
    const results: string[] = [];
    for (const n of [1, 2]) {
      const r = await call({
        purpose: `example-${n}`,
        system: 'You are a test. Reply with JSON only.',
        user: `Say hello in three words and add 2 + ${n}.`,
        schema: SCHEMA,
        effort: 'low',
        maxTokens: 300,
      });
      results.push(r.json ? `#${n} OK ${r.ms} ms ${JSON.stringify(r.json)}` : `#${n} FAILED ${r.ms} ms: ${r.error}`);
      setModel('model: ' + results.join('\n'));
    }
  };

  const runHub = () => {
    mind.current?.stop();
    setHub('hub: connecting…');
    mind.current = startMind({
      hubUrl: HUB_URL,
      token: 'dev',
      env: { OPENAI_API_KEY: API_KEY },
      log,
      hints: [],
    });
  };

  useEffect(() => {
    runHub();
    runModel();
    return () => mind.current?.stop();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>bobby-mind in Expo</Text>
      <Text style={styles.status}>{model}</Text>
      <Text style={styles.status}>{hub}</Text>
      <View style={styles.row}>
        <Button title="Model again" onPress={runModel} />
        <Button title="Reconnect hub" onPress={runHub} />
      </View>
      <ScrollView style={styles.log}>
        {lines.map((l, i) => (
          <Text key={i} style={styles.line}>
            {l}
          </Text>
        ))}
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 48, paddingHorizontal: 12 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  status: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  row: { flexDirection: 'row', gap: 12, marginVertical: 8 },
  log: { flex: 1, backgroundColor: '#f4f4f4', padding: 6 },
  line: { fontFamily: 'monospace', fontSize: 10, marginBottom: 3 },
});
