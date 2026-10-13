import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // Tools are command-line entry points: the environment is their configuration,
    // and there is no config module to route it through.
    files: ['**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
