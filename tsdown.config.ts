/**
 * tsdown build for dsh-timeline:
 *
 * - `lib/index.js` — the host half (ESM node): one fenced HTTP route
 *   `/history/api` that reads the full session log through `sessionQuery`
 *   and returns every `user/message` event the human sent.
 * - `lib/client.js` — the browser client bundle (CJS closure factory),
 *   registering with the package-name id `dsh-timeline` (the client-modules
 *   compose keys on the package name; keep it in sync with package.json
 *   `name`). Externals resolve through the web shell's module table
 *   (react, cordis, ui-slots, ...); everything else is inlined. The bundle
 *   registers itself via `window.__ModuleLoader__.load({ id, factory })`
 *   with the `(require) => exports` CJS closure shape.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation',
]

/** Host half: plain ESM node output. */
const hostConfig: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^node:/, '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session'],
  },
}

/**
 * One client bundle build for a plugin id. The same src/client/index.ts is
 * compiled twice with only the registered id and the output file name
 * differing: the npm/GitHub channel uses the package name (`dsh-timeline`)
 * and the plugin-registry channel uses the manifest id
 * (`dsh-external/dsh-timeline`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    // CJS output otherwise makes some transitive packages resolve their
    // Node entry even though this bundle runs in the browser. Keep browser
    // conditional exports authoritative for both source import() and
    // generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    outputOptions: {
      entryFileNames: entryFile,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries;
      // it cannot load relative chunk URLs in the browser. Disable code
      // splitting so every artifact is one script.
      codeSplitting: false,
    },
  }
}

export default [
  hostConfig,
  clientBundle('dsh-timeline', 'client.js'),
  clientBundle('dsh-external/dsh-timeline', 'client-registry.js'),
]
