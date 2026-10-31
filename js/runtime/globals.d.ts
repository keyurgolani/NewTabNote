/**
 * The names the build writes values in place of (scripts/build/vite-config.js's define), as the
 * strict project sees them (tsconfig.strict.json)
 */
export {};

declare global {
  /** The build's ID, which the loader compares with build-info.json's (js/runtime/lazy.js) */
  const __NTN_BUILD_ID__: string;
}
