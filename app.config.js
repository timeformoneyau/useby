/**
 * app.json is the configuration. This file exists for one exception only.
 *
 * The flow-test build that CI installs on an emulator (USEBY_E2E=1) must run
 * the code under test, so over-the-air updates are switched off for it.
 * Otherwise it would download whatever was last published to a channel and
 * the tests would be exercising yesterday's code.
 *
 * Every other build gets app.json untouched. That matters beyond tidiness:
 * the runtime version is a fingerprint of this config, so anything computed
 * here from the environment would make a phone's build and a published update
 * disagree about compatibility.
 */
module.exports = ({ config }) => {
  if (process.env.USEBY_E2E !== '1') return config;
  return { ...config, updates: { ...config.updates, enabled: false } };
};
