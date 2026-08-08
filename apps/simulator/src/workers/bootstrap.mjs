/**
 * Worker bootstrap.
 *
 * Registers the `.js` → `.ts` resolve hook *before* importing anything from the
 * workspace, because the workspace packages point `main` straight at TypeScript
 * and use `.js` specifiers between their own modules. Node strips the types on
 * its own; only the extension rewrite is missing, and that is all the hook does.
 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);

await import('./worker.ts');
