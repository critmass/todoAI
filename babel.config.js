module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // zod v4 ships `export * as x from '...'` (ES2020 namespace re-export) in its untranspiled
  // node_modules source; @react-native/babel-preset doesn't include this plugin by default,
  // and Metro (unlike Jest) transforms node_modules too, so it needs to be explicit here.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
