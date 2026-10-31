#!/usr/bin/env node

/**
 * Build script for New Tab Note Chrome Extension (#27). The build itself is
 * scripts/build/main.js, typed strictly with the rest of scripts/build/: Vite bundles the
 * pages and the service worker, and the build checks what it wrote before any dist/ exists.
 *
 *   node scripts/build.js          production build
 *   node scripts/build.js --dev    development build: JavaScript as the bundler writes it,
 *                                  unminified, and CSS minified as in production, so a
 *                                  stylesheet lightningcss refuses fails both
 *   --strict                       accepted and ignored: what it refused before #27 is the only
 *                                  behavior, and CI still passes it
 */

const main = require('./build/main.js');

// Run the build when invoked as a script; tests require what it exports
if (require.main === module) {
  main.build().catch(error => {
    console.error(`\n✗ Build failed: ${error && error.stack ? error.stack : error}. No dist/ was written.`);
    process.exit(1);
  });
}

module.exports = { ...require('./build/vite-config.js'), ...require('./build/inputs.js'), ...main };
