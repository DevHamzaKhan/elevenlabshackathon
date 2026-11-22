import { useEffect, useState } from 'react';
import { AppState, Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import Hands, { HandsStatus, SettingsPage } from 'bobby-hands';

// The test app always uses the token `dev`, so `tools/drive.mjs` can connect without setup.
const TOKEN = 'dev';

type Row = { key: keyof HandsStatus; page: SettingsPage; label: string };

const ROWS: Row[] = [
  { key: 'accessibility', page: 'accessibility', label: 'Accessibility service (Bobby Hands)' },
  { key: 'notificationAccess', page: 'notificationAccess', label: 'Notification access' },
  { key: 'notifications', page: 'notifications', label: 'Notifications' },
];

export default function App() {
  const [st, setSt] = useState<HandsStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    try {
      Hands.configure({ token: TOKEN });
    } catch (e) {
      setErr(String(e));
    }
    const read = () => {
      try {
        setSt(Hands.status());
      } catch (e) {
        setErr(String(e));
      }
    };
    read();
    const t = setInterval(read, 1000);
    const sub = AppState.addEventListener('change', read);
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, []);

  const p = st?.peers;
  const line = st
    ? `hub ${st.hubRunning ? 'up' : 'down'} · hands ${p?.hands ? '●' : '○'} mind ${p?.mind ? '●' : '○'} mouth ${
        p?.mouth ? '●' : '○'
      } caller ${p?.caller ? '●' : '○'} · watch ${p?.watch ?? 0}`
    : 'reading status…';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Bobby Hands</Text>
      <Text style={styles.sub}>Test app · token "{TOKEN}"</Text>

      {ROWS.map((r) => {
        const ok = !!st?.[r.key];
        return (
          <View key={r.key} style={styles.row}>
            <Text style={[styles.dot, { color: ok ? '#1a9b4b' : '#c33' }]}>{ok ? '✓' : '✗'}</Text>
            <Text style={styles.label}>{r.label}</Text>
            {!ok && <Button title="Open" onPress={() => Hands.openSettings(r.page)} />}
          </View>
        );
      })}

      <Text style={styles.status} testID="status">
        {line}
      </Text>
      {st && !st.serviceRunning && st.accessibility ? (
        <Text style={styles.warn}>The service is switched on but not running yet. Toggle it off and on.</Text>
      ) : null}
      {err ? <Text style={styles.warn}>{err}</Text> : null}

      <View style={{ height: 24 }} />
      <Button title="Move to back" onPress={() => Hands.moveToBack()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 28, fontWeight: '700' },
  sub: { color: '#666', marginBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  dot: { fontSize: 20, width: 24 },
  label: { flex: 1, fontSize: 16 },
  status: { marginTop: 24, fontFamily: 'monospace', fontSize: 13 },
  warn: { marginTop: 12, color: '#c33' },
});
