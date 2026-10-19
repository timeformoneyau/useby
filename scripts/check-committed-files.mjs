/**
 * Fails if the repo tracks a file that should only ever live in a secret store.
 *
 * gitleaks (the other half of the CI secret check) looks *inside* files for
 * things shaped like keys. This looks at file *names* — an `.env` or a
 * keystore is a leak whatever it contains, and a key format gitleaks does not
 * recognise would slip past a content scan. It also checks `.env.example`
 * holds names only, since that is the one env file deliberately committed.
 *
 * Run: node scripts/check-committed-files.mjs   (exit 1 on any finding)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /\.(jks|keystore|p8|p12|pem|key|mobileprovision)$/i,
  /(^|\/)credentials\.json$/,
  /(^|\/)google-services\.json$/,
  /(^|\/)GoogleService-Info\.plist$/,
  /(^|\/)service-account[^/]*\.json$/,
];

/** Tracked paths that must not be committed. */
export function forbiddenFiles(paths) {
  return paths.filter((p) => FORBIDDEN.some((re) => re.test(p)));
}

/** Names in an env-example file that have a value filled in. */
export function filledEnvValues(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
    .filter((m) => m && m[2].replace(/^["']|["']$/g, '').trim() !== '')
    .map((m) => m[1]);
}

function main() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const problems = forbiddenFiles(tracked).map(
    (p) => `${p}: this kind of file must never be committed`,
  );
  if (tracked.includes('.env.example')) {
    for (const name of filledEnvValues(readFileSync('.env.example', 'utf8'))) {
      problems.push(`.env.example: ${name} has a value — this file holds names only`);
    }
  }
  if (problems.length) {
    console.error('Committed-secrets check failed:\n  ' + problems.join('\n  '));
    console.error('Remove the file from git (git rm --cached <path>) and rotate anything it held.');
    process.exit(1);
  }
  console.log(`Committed-secrets check passed (${tracked.length} tracked files).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
