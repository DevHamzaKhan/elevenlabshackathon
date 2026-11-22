// MainActivity keeps the intent it was first started with; React Native never calls setIntent()
// on a new one. Bobby is usually already running (keep-alive), so tapping its notification
// arrives through onNewIntent, and Hands' openedFromNotification() (which reads
// activity.intent) would miss it. This makes the newest intent the activity's intent.
const { withMainActivity } = require('expo/config-plugins');

const MARK = '// bobby: setIntent on new intent';

module.exports = function withNewIntent(config) {
  return withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (cfg.modResults.language !== 'kt' || src.includes(MARK)) return cfg;
    if (!src.includes('import android.content.Intent')) {
      src = src.replace(/^package .*$/m, (m) => `${m}\n\nimport android.content.Intent`);
    }
    const method = `
  ${MARK}
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`;
    const end = src.lastIndexOf('}');
    src = src.slice(0, end) + method + src.slice(end);
    cfg.modResults.contents = src;
    return cfg;
  });
};
