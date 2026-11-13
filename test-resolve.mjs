// Test-only module resolution shim.
//
// The Harness runtime resolves `@deepseek-ai/schemastery` through its own
// profile-resolution layer (dsh-app-boot patches Module._resolveFilename and the
// ESM resolver) and points it at the vendored 3.19 build inside app.asar. Plain
// `node` has no such layer and the profile's public `schemastery` is 3.18, which
// lacks `.volatile()`. This hook therefore redirects both packages to a copy of
// the runtime build extracted next to this file; it is never loaded at runtime.
//
// Run a test with:  node --import ./test-resolve.mjs test-standalone.mjs
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "产出", "scratch", "sm-runtime", "@deepseek-ai");

const MAP = new Map([
  ["@deepseek-ai/schemastery", join(ROOT, "schemastery", "lib", "index.mjs")],
  ["@deepseek-ai/cosmokit", join(ROOT, "cosmokit", "lib", "index.js")],
]);

for (const [name, path] of MAP) {
  if (!existsSync(path)) throw new Error(`test-resolve: ${name} not found at ${path}`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const path = MAP.get(specifier);
    if (path !== undefined) return { url: pathToFileURL(path).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
