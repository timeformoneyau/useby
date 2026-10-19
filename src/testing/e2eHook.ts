/**
 * Deliberately empty in every real build.
 *
 * This is the one place the CI flow-test build attaches its test mode: when
 * metro.config.js sees USEBY_E2E=1 it bundles e2e/app/setup.ts in place of
 * this file. Production and preview builds bundle exactly what you see here
 * (nothing), and CI checks their bundle contains no test-mode code at all —
 * there is no runtime switch that could turn it on.
 */
export {};
