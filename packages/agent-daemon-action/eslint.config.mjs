import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // GitHub Actions receive their inputs and context as environment variables;
    // the environment is this entry point's configuration.
    files: ['**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
