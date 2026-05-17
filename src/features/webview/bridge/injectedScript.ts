import { APP_VERSION } from '../../../config/env';

// Runs before content loads. Marks the page as running inside the native app
// so the web's bridge.js can detect native context before it initializes.
// All bridge methods themselves live on window.YoungmanBridge, defined by web.
export const buildInjectedScript = (): string => `
(function() {
  if (window.__YOUNGMAN_NATIVE__) { return; }
  window.__YOUNGMAN_NATIVE__ = {
    platform: 'android',
    appVersion: '${APP_VERSION}'
  };
})();
true;
`;
