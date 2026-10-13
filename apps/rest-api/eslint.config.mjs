import baseConfig from '../../eslint.config.mjs';

// No @nx/dependency-checks: this project ships a Vite bundle, and what it must
// declare is what the bundle leaves external. The `check:externals` target
// checks that against the build output.
export default [...baseConfig];
