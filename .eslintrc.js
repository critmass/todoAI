module.exports = {
  root: true,
  extends: '@react-native',
  // `docs/` holds the task 23 design prototype, which ships its own browser runtime
  // (docs/design/support.js). It is a reference artifact, not app source: it targets the DOM
  // rather than React Native, so linting it under this config reports errors about `document`,
  // `customElements` and friends that mean nothing here. Excluded so `eslint .` says something
  // true about the code we actually ship.
  ignorePatterns: ['docs/**', 'android/**', 'ios/**'],
};
