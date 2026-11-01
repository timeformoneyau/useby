/**
 * Node module hooks that let the offline suite load app modules which are not
 * written to be loaded under Node's type stripping.
 *
 * Most of the domain layer has no value imports, and the suite loads it
 * directly. The item service is different: it is the storage half, so it
 * imports AsyncStorage, reaches the filesystem through `photoStore`, and uses
 * extensionless relative imports and non-`type` imports of interfaces, all of
 * which Metro accepts and Node's type stripping does not. That left the whole
 * persistence path — the round trip a date edit depends on, the order
 * `removeItem` writes in, the urgency sort the list is built from — tested only
 * by hand on a phone.
 *
 * This file changes no app code. It does three things, test-process only:
 *
 *   1. Compiles `.ts` under `src/` with the TypeScript compiler already in
 *      devDependencies, which elides type-only imports the way Metro's Babel
 *      transform does.
 *   2. Resolves extensionless relative imports to `.ts` / `.tsx` / `index.ts`.
 *   3. Swaps the two native modules the service reaches — AsyncStorage and
 *      `expo-file-system` — for in-memory stand-ins that read their state from
 *      `globalThis.__USEBY_STUBS__`, which the test sets up before importing.
 *
 * Registered from inside a test file (`register(...)`), so it applies to that
 * file's process only. `node --test` runs every file in its own process, so no
 * other suite sees it.
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const STUBS = {
  '@react-native-async-storage/async-storage': 'useby-stub:async-storage',
  'expo-file-system': 'useby-stub:expo-file-system',
};

const STUB_SOURCE = {
  'useby-stub:async-storage': `
    const s = globalThis.__USEBY_STUBS__?.asyncStorage;
    if (!s) throw new Error('set globalThis.__USEBY_STUBS__.asyncStorage before importing app code');
    export default s;
  `,
  'useby-stub:expo-file-system': `
    const s = globalThis.__USEBY_STUBS__?.fileSystem;
    if (!s) throw new Error('set globalThis.__USEBY_STUBS__.fileSystem before importing app code');
    export const Directory = s.Directory;
    export const File = s.File;
    export const Paths = s.Paths;
  `,
};

async function isFile(url) {
  try {
    return (await stat(fileURLToPath(url))).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
  if (STUB_SOURCE[specifier]) return { url: specifier, shortCircuit: true };

  const parent = context.parentURL ?? '';
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && parent.includes('/src/') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = new URL(specifier + suffix, parent).href;
      if (await isFile(candidate)) return { url: candidate, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (STUB_SOURCE[url]) {
    return { format: 'module', source: STUB_SOURCE[url], shortCircuit: true };
  }
  if (url.startsWith('file:') && url.includes('/src/') && /\.tsx?$/.test(url)) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        // Preserve `.ts` specifiers written with allowImportingTsExtensions.
        rewriteRelativeImportExtensions: false,
        verbatimModuleSyntax: false,
        isolatedModules: true,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
