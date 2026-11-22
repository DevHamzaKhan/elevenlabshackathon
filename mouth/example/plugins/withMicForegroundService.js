// Declares react-native-background-actions' service as a foreground service of type
// "microphone", so Bobby keeps hearing and speaking while another app is on screen.
// Android requires the type in the manifest to match the one passed at start().
const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

const SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";

module.exports = function withMicForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = (app.service || []).filter((s) => s.$["android:name"] !== SERVICE);
    app.service.push({
      $: {
        "android:name": SERVICE,
        "android:foregroundServiceType": "microphone",
        "android:exported": "false",
        "tools:replace": "android:foregroundServiceType",
      },
    });
    return cfg;
  });
};
