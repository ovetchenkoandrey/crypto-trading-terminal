// Entry point for `node --import ./scripts/tsLoader.mjs`. See tsHooks.mjs.

import { register } from "node:module";

register("./tsHooks.mjs", import.meta.url);
