// Extension resolution for `node scripts/*.ts`.
//
// Node 24 strips TypeScript types natively, but ESM resolution stays strict:
// `import "./foo"` is not resolved to `./foo.ts`. Most of `src/lib/` is written
// for the bundler and imports without extensions, so a plain `node` run of any
// script that reaches into it dies with ERR_MODULE_NOT_FOUND.
//
// Rather than rewrite hundreds of imports in files other work is touching, this
// hook retries a failed relative resolution with `.ts` and `/index.ts`. It only
// ever fires after the standard resolution has already failed, so it cannot
// shadow a real module.

const CANDIDATES = [".ts", "/index.ts"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const code = err && err.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw err;
    if (!(specifier.startsWith(".") || specifier.startsWith("/"))) throw err;
    for (const suffix of CANDIDATES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        /* try the next shape */
      }
    }
    throw err;
  }
}
