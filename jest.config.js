module.exports = {
  preset: '@react-native/jest-preset',
  // Stubs for the two native modules that throw at import time outside a real RN runtime, so the
  // app's own entry point can be mounted in a test. See jest.setup.js — nothing else in the suite
  // relies on them.
  setupFiles: ['<rootDir>/jest.setup.js'],
};
