import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type { SettingsPage } from 'bobby-hands';

import {
  getState,
  handleUrl,
  HUB_URL,
  init,
  missing,
  onState,
  setSwitch,
  stopBobby,
  wake,
} from './src/bobby';
import { hands, handsMissing } from './src/hands';
import { getLines, log, onLog } from './src/log';
import type { Part } from './src/types';

// A trip to a permission dialog or a settings page pauses the app; coming back from it
// should not wake Bobby.
let suppressWakeUntil = 0;
let lastLinkAt = 0;
const quietFor = (ms: number) => (suppressWakeUntil = Date.now() + ms);

async function onUrl(url: string | null | undefined) {
  if (url && (await handleUrl(url))) {
    lastLinkAt = Date.now();
    log(`opened by link ${url.split('?')[0]}`);
  }
}

/** Called each time the app comes to the front. */
let lastFrontAt = 0;
async function cameToFront(reason: string) {
  // A cold start can report both the first render and an AppState change: wake once.
  if (Date.now() - lastFrontAt < 1500) return;
  lastFrontAt = Date.now();
  await init();
  // Let a deep link or the notification flag arrive first.
  await new Promise((r) => setTimeout(r, 400));
  if (hands.openedFromNotification()) {
    hands.clearOpenedFromNotification();
    log('opened from the notification: showing settings');
    return;
  }
  if (Date.now() - lastLinkAt < 3000) return;
  if (Date.now() < suppressWakeUntil) return;
  wake(reason);
}

function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function useSubscribe(sub: (fn: () => void) => () => void) {
  const [, setN] = useState(0);
  useEffect(() => sub(() => setN((n) => n + 1)), [sub]);
}

export default function App() {
  const started = useRef(false);
  useTick(1000);
  useSubscribe(onState);
  useSubscribe(onLog);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const linkSub = Linking.addEventListener('url', (e) => void onUrl(e.url));
    void (async () => {
      await onUrl(await Linking.getInitialURL());
      await cameToFront('opened');
    })();
    let prev = AppState.currentState;
    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && prev !== 'active') void cameToFront('came to front');
      prev = next;
    });
    return () => {
      linkSub.remove();
      appSub.remove();
    };
  }, []);

  const st = getState();
  const status = hands.status();
  const miss = st.ready ? missing() : [];
  const handsErr = handsMissing();

  const open = (which: SettingsPage) => {
    quietFor(120000);
    hands.openSettings(which);
  };
  const askMic = async () => {
    quietFor(30000);
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    log(`microphone: ${r}`);
    if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) open('microphone');
  };
  const askNotifications = async () => {
    quietFor(30000);
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      log(`notifications: ${r}`);
      if (r !== PermissionsAndroid.RESULTS.GRANTED) open('notifications');
    } else open('notifications');
  };

  const checklist: { label: string; ok: boolean; fix: () => void }[] = [
    { label: 'Accessibility service (Bobby Hands)', ok: status.accessibility, fix: () => open('accessibility') },
    { label: 'Notification access', ok: status.notificationAccess, fix: () => open('notificationAccess') },
    { label: 'Post notifications', ok: status.notifications, fix: askNotifications },
    { label: 'Microphone', ok: status.microphone, fix: askMic },
  ];
  const lights: { label: string; on: boolean }[] = [
    { label: 'hub', on: status.hubRunning },
    { label: 'hands', on: status.peers.hands },
    { label: 'mind', on: status.peers.mind },
    { label: 'mouth', on: status.peers.mouth },
    { label: 'caller', on: status.peers.caller },
    { label: `watch ${status.peers.watch}`, on: status.peers.watch > 0 },
    { label: 'keep-alive', on: !!status.keepAlive },
  ];
  const names = Object.keys(st.env).sort();

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Bobby</Text>
        <Text style={miss.length ? styles.warn : styles.good}>
          {!st.ready ? 'Starting…' : miss.length ? `Not ready: ${miss.join(', ')}` : 'Ready. Open the app to wake Bobby.'}
        </Text>
        {handsErr ? <Text style={styles.warn}>Hands native module missing: {handsErr}</Text> : null}

        <Text style={styles.h}>Permissions</Text>
        {checklist.map((c) => (
          <View key={c.label} style={styles.row}>
            <View style={[styles.dot, c.ok ? styles.on : styles.bad]} />
            <Text style={styles.label}>{c.label}</Text>
            {!c.ok && (
              <Pressable style={styles.btn} onPress={c.fix}>
                <Text style={styles.btnText}>Grant</Text>
              </Pressable>
            )}
          </View>
        ))}

        <Text style={styles.h}>Parts</Text>
        {(['mind', 'mouth', 'caller'] as Part[]).map((p) => (
          <View key={p} style={styles.row}>
            <Text style={styles.label}>
              {p[0].toUpperCase() + p.slice(1)} {st.running[p] ? '(running)' : ''}
            </Text>
            <Switch value={st.switches[p]} onValueChange={(v) => void setSwitch(p, v)} />
          </View>
        ))}

        <Text style={styles.h}>Status</Text>
        <View style={styles.lights}>
          {lights.map((l) => (
            <View key={l.label} style={styles.light}>
              <View style={[styles.dot, l.on ? styles.on : styles.off]} />
              <Text style={styles.small}>{l.label}</Text>
            </View>
          ))}
        </View>
        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={() => wake('button')}>
            <Text style={styles.btnText}>Wake now</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={stopBobby}>
            <Text style={styles.btnText}>Stop keep-alive</Text>
          </Pressable>
        </View>

        <Text style={styles.h}>Hub</Text>
        <Text style={styles.small}>{HUB_URL}</Text>
        <Text style={styles.mono} selectable>
          HUB_TOKEN {st.env.HUB_TOKEN || '…'}
        </Text>

        <Text style={styles.h}>Stored settings ({names.length})</Text>
        <Text style={styles.small}>{names.length ? names.join('\n') : 'None. Run app/tools/push-config.mjs.'}</Text>

        <Text style={styles.h}>Log</Text>
        <Text style={styles.mono} selectable>
          {getLines().join('\n') || '(empty)'}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingTop: 56, paddingBottom: 48 },
  title: { fontSize: 30, fontWeight: '700', color: '#1B1640' },
  h: { fontSize: 17, fontWeight: '600', marginTop: 22, marginBottom: 8, color: '#1B1640' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  label: { flex: 1, fontSize: 15 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  on: { backgroundColor: '#22A559' },
  off: { backgroundColor: '#C9C9D1' },
  bad: { backgroundColor: '#E5484D' },
  good: { color: '#22A559', marginTop: 6 },
  warn: { color: '#C2410C', marginTop: 6 },
  btn: { backgroundColor: '#7C5CFF', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
  lights: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  light: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { fontSize: 13, color: '#444' },
  mono: { fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo', fontSize: 11, color: '#333' },
});
