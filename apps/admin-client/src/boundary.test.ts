import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundaries ADR 0023 draws around the administrator bundle, read from the
 * files rather than promised in prose.
 *
 * Every claim here is about something **absent**, and a promise about absence
 * rots quietly: it stays true until the first commit that needs the thing, and
 * nothing fails at that moment. `@tcg/admin-contracts` and `@tcg/admin-server`
 * already keep their halves of the boundary this way; this is the third.
 *
 * Four properties, and each is a sentence from the ADR or the milestone:
 *
 * - **Nothing admin is reachable from the player bundle.** ADR 0023 §1: a
 *   separate bundle is what makes "a player build cannot ship an admin control"
 *   a fact rather than a guard that could be wrong.
 * - **This application talks to the orchestration process and never is one.** It
 *   imports the contract, not the server, not the simulator and no Node built-in.
 * - **The token is never anything the browser persists.** ADR 0023 §4, which is
 *   a claim about storage APIs that appear in no source.
 * - **A request never names a location.** ADR 0023 §5, which here means the
 *   client sends relative addresses and holds no host, port or root of its own.
 */

const SOURCE_ROOT = import.meta.dirname;
const PACKAGE_ROOT = join(SOURCE_ROOT, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

interface SourceFile {
  readonly name: string;
  readonly text: string;
}

/** A source file's code, with comments removed — the same reason the other two give. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every shipped source, which is every source outside `src/test/`.
 *
 * The harness and the fake service are test scaffolding: they are never
 * imported by the bundle, and holding them to the same rules would mean a fake
 * lab could not be written at all.
 */
function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test') continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      files.push({ name: entry.name, text: codeOf(readFileSync(path, 'utf8')) });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

function manifestOf(path: string): {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof manifestOf>;
}

const MANIFEST = manifestOf(join(PACKAGE_ROOT, 'package.json'));

describe('the client is a browser application and nothing else', () => {
  it('has enough sources for the scans below to mean something', () => {
    expect(sourceFiles().length).toBeGreaterThan(8);
  });

  it('imports no Node built-in, so nothing here can be run as a process', () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/from '(node:[a-z/]+)'/);
      expect(file.text).not.toMatch(/require\(/);
    }
  });

  it('imports the admin contract, and never the process on the other side of it', () => {
    // ADR 0023 §1 and §2: the orchestration process owns the store, the queue
    // and the simulator. A screen that imported one would put a worker pool in a
    // browser bundle and a second copy of the lifecycle table beside it.
    for (const file of sourceFiles()) {
      expect(file.text).not.toContain("from '@tcg/admin-server'");
      expect(file.text).not.toContain("from '@tcg/simulator'");
      expect(file.text).not.toContain("from '@tcg/rules-engine'");
      expect(file.text).not.toContain("from '@tcg/deck-generator'");
      expect(file.text).not.toContain("from '@tcg/bot-interface'");
      expect(file.text).not.toContain("from '@tcg/web-client'");
      expect(file.text).not.toContain("from '@tcg/multiplayer-server'");
    }
  });

  it('actually imports the contract somewhere, so the allowance above does work', () => {
    const importers = sourceFiles().filter((file) =>
      file.text.includes("from '@tcg/admin-contracts'"),
    );
    expect(importers.length).toBeGreaterThan(2);
  });

  it('spawns nothing and invokes no shell', () => {
    for (const file of sourceFiles()) {
      for (const capability of ['child_process', 'spawn(', 'execFile', 'execSync']) {
        expect(`${file.name}: ${String(file.text.includes(capability))}`).toBe(
          `${file.name}: false`,
        );
      }
    }
  });
});

describe('the token is never anything the browser persists', () => {
  it('names no storage API in any source', () => {
    // ADR 0023 §4. The connection suite watches the real APIs from the other
    // side; this is the half that fails when somebody adds "remember me".
    for (const file of sourceFiles()) {
      for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
        expect(`${file.name}: ${api}: ${String(file.text.includes(api))}`).toBe(
          `${file.name}: ${api}: false`,
        );
      }
    }
  });

  it('holds the token in one file, behind a private field', () => {
    const session = readFileSync(join(SOURCE_ROOT, 'net', 'session.ts'), 'utf8');
    expect(session).toContain('#token');
    // The published state has no field for one, so no screen can print it.
    expect(session).not.toMatch(/readonly token:/);
  });

  it('writes no token, root or resolved path into anything it logs', () => {
    // The service keeps its banner clean for the same reason (ADR 0023 §4). Here
    // the rule is simpler to state: this application logs nothing at all.
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/console\.(?:log|warn|error|info|debug)\(/);
    }
  });
});

describe('a request names no location', () => {
  it('builds every address from the contract, never from a host or a port', () => {
    const transport = readFileSync(join(SOURCE_ROOT, 'net', 'transport.ts'), 'utf8');
    expect(transport).toContain('adminEndpointPath');
    // No scheme, no host, no port: the address is relative, so a browser can
    // only ever send it to the origin this page was served from.
    expect(codeOf(transport)).not.toMatch(/https?:\/\//);
    expect(codeOf(transport)).not.toMatch(/\blocalhost\b/);
    expect(codeOf(transport)).not.toMatch(/\b127\.0\.0\.1\b/);
  });

  it('has one file that reaches the network, and it is the transport', () => {
    for (const file of sourceFiles()) {
      if (file.name === 'transport.ts') continue;
      expect(`${file.name}: ${String(file.text.includes('fetch('))}`).toBe(`${file.name}: false`);
      expect(file.text).not.toContain('XMLHttpRequest');
      expect(file.text).not.toContain('WebSocket');
      expect(file.text).not.toContain('EventSource');
    }
  });

  it('re-parses every answer against the endpoint’s own response schema', () => {
    // The service validates on the way out; this is the other end of the same
    // check, and it is the reason an unknown field in an answer is refused
    // rather than rendered.
    const transport = readFileSync(join(SOURCE_ROOT, 'net', 'transport.ts'), 'utf8');
    expect(transport).toContain('adminResponse(ADMIN_ENDPOINTS[name].response).safeParse');
    expect(transport).toContain('refuseFutureVersion');
    expect(transport).toContain('refusePastVersion');
  });
});

describe('the dev proxy restates two of the service’s constants, and must not drift', () => {
  it('targets the host and port the orchestration process defaults to', () => {
    // `apps/admin-client` must not import `apps/admin-server`, so the default
    // bind is written into the Vite config rather than imported. That is a
    // restated constant, and this is the only honest way to hold one still.
    const config = readFileSync(join(PACKAGE_ROOT, 'vite.config.ts'), 'utf8');
    const service = readFileSync(
      join(REPO_ROOT, 'apps', 'admin-server', 'src', 'service', 'config.ts'),
      'utf8',
    );

    const servicePort = /DEFAULT_PORT = (\d+)/.exec(service)?.[1];
    const serviceHost = /DEFAULT_HOST = '([^']+)'/.exec(service)?.[1];
    expect(servicePort).toBeDefined();
    expect(serviceHost).toBeDefined();

    expect(config).toContain(`ADMIN_SERVICE_PORT = process.env.TCG_ADMIN_PORT ?? '${servicePort}'`);
    expect(config).toContain(`ADMIN_SERVICE_HOST = process.env.TCG_ADMIN_HOST ?? '${serviceHost}'`);
  });

  it('reads the same environment keys the service does, so one setting moves both', () => {
    const config = readFileSync(join(PACKAGE_ROOT, 'vite.config.ts'), 'utf8');
    const service = readFileSync(
      join(REPO_ROOT, 'apps', 'admin-server', 'src', 'service', 'config.ts'),
      'utf8',
    );
    for (const key of ['TCG_ADMIN_HOST', 'TCG_ADMIN_PORT']) {
      expect(config).toContain(key);
      expect(service).toContain(key);
    }
  });

  it('forwards the API on both the dev server and the preview server', () => {
    // A built bundle previewed locally has to behave the way the dev one does,
    // or the origin policy would be true only under `vite dev`.
    const config = readFileSync(join(PACKAGE_ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('server: { port: 5174, proxy: adminProxy }');
    expect(config).toContain('preview: { port: 5174, proxy: adminProxy }');
  });

  it('does not add CORS headers to the service instead', () => {
    // The origin policy M08.6 deferred: keep sending none, and make the
    // browser's request same-origin. A CORS allowance would be a standing
    // statement that *some* other origin may read a lab's answers, configured on
    // the same machine that holds the token; a proxy needs no such statement.
    const walk = (directory: string, hits: string[]): string[] => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path, hits);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (/access-control-allow/i.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
      return hits;
    };
    expect(walk(join(REPO_ROOT, 'apps', 'admin-server', 'src'), [])).toEqual([]);
  });

  it('leaves the service’s own no-CORS assertion in place, over a real socket', () => {
    // The scan above proves the header is not written; this proves the check
    // that would notice is still there. M08.6 wrote it before there was a client
    // to have an origin at all.
    const suite = readFileSync(
      join(REPO_ROOT, 'apps', 'admin-server', 'src', 'service', 'http.test.ts'),
      'utf8',
    );
    expect(suite).toContain("access-control-allow-origin')).toBeNull()");
  });
});

describe('the declared dependencies', () => {
  it('are the admin contract and React, and nothing that could run an experiment', () => {
    expect(MANIFEST.name).toBe('@tcg/admin-client');
    expect(Object.keys(MANIFEST.dependencies ?? {}).sort()).toEqual([
      '@tcg/admin-contracts',
      'react',
      'react-dom',
    ]);
  });

  it('cover every workspace import the sources actually make', () => {
    const imported = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(/from '(@tcg\/[a-z-]+)'/g)) {
        imported.add(match[1] as string);
      }
    }
    const declared = new Set(Object.keys(MANIFEST.dependencies ?? {}));
    for (const name of imported) expect([...declared]).toContain(name);
  });

  it('adopts no charting library, because no tranche has needed one yet', () => {
    // ADR 0023 §6: the default is hand-authored SVG plus the exact table every
    // chart must accompany anyway, and the tranche that finds a real reason
    // records the choice, its bundle cost and its accessibility behaviour.
    const everything = { ...MANIFEST.dependencies, ...MANIFEST.devDependencies };
    for (const name of Object.keys(everything)) {
      expect(name).not.toMatch(/chart|d3|plotly|recharts|victory|nivo/i);
    }
  });
});

describe('nothing admin is reachable from the player bundle', () => {
  it('is absent from the web client’s dependencies', () => {
    const client = manifestOf(join(REPO_ROOT, 'apps', 'web-client', 'package.json'));
    for (const set of [client.dependencies, client.devDependencies]) {
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-client');
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-contracts');
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-server');
    }
  });

  it('is absent from the live match server’s dependencies', () => {
    const server = manifestOf(join(REPO_ROOT, 'apps', 'multiplayer-server', 'package.json'));
    for (const name of ['@tcg/admin-client', '@tcg/admin-contracts', '@tcg/admin-server']) {
      expect(Object.keys(server.dependencies ?? {})).not.toContain(name);
    }
  });

  it('is imported by no source outside this workspace', () => {
    const hits: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (path.startsWith(PACKAGE_ROOT)) continue;
        if (readFileSync(path, 'utf8').includes("'@tcg/admin-client'")) hits.push(path);
      }
    };
    for (const root of ['packages', 'apps']) walk(join(REPO_ROOT, root));
    expect(hits).toEqual([]);
  });

  it('is its own Vite application, with its own entry point and its own output', () => {
    // ADR 0023 §1: its own `index.html` and its own bundle. Two applications
    // that shared either would be one application with a flag.
    const html = readFileSync(join(PACKAGE_ROOT, 'index.html'), 'utf8');
    const playerHtml = readFileSync(join(REPO_ROOT, 'apps', 'web-client', 'index.html'), 'utf8');
    expect(html).toContain('/src/main.tsx');
    expect(html).toContain('id="admin-root"');
    expect(playerHtml).not.toContain('admin');
    expect(html).not.toContain('id="root"');
  });

  it('serves no public directory, so the player’s assets are not on this origin', () => {
    const config = readFileSync(join(PACKAGE_ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('publicDir: false');
  });

  it('is built and typechecked by the repository’s own gate', () => {
    // A workspace the gate does not build is a workspace that breaks quietly.
    const root = manifestOf(join(REPO_ROOT, 'package.json'));
    expect(root.scripts?.build).toContain('@tcg/admin-client');
    expect(MANIFEST.scripts?.typecheck).toBe('tsc --noEmit -p tsconfig.json');
    expect(MANIFEST.scripts?.build).toBe('vite build');
  });
});
