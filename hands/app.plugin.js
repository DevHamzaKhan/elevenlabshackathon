// Config plugin for bobby-hands. The services, permissions and <queries> live in the library's
// own AndroidManifest.xml and are merged automatically. This plugin adds what a library
// manifest can't:
//  - cleartext traffic, so the app's own clients can reach ws://127.0.0.1:8765;
//  - minSdk 30 (the package uses Android 11 APIs), via gradle.properties.
const { withAndroidManifest, withGradleProperties } = require('expo/config-plugins');

const MIN_SDK = 30;

function withMinSdk(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const i = props.findIndex((p) => p.type === 'property' && p.key === 'android.minSdkVersion');
    const cur = i >= 0 ? parseInt(props[i].value, 10) : 0;
    if (!(cur >= MIN_SDK)) {
      const entry = { type: 'property', key: 'android.minSdkVersion', value: String(MIN_SDK) };
      if (i >= 0) props[i] = entry;
      else props.push(entry);
    }
    return cfg;
  });
}

function withCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
}

module.exports = function withBobbyHands(config) {
  return withCleartext(withMinSdk(config));
};
