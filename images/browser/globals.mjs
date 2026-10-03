// Loaded into every Node process (NODE_OPTIONS=--import): lets ESM `import` find the packages installed globally
// in this image, as NODE_PATH already does for require(). Only a bare specifier that failed to resolve normally is
// retried, so a project's own node_modules always wins.
import { register } from 'node:module';

register('./globals-hooks.mjs', import.meta.url);
