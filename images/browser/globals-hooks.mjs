import { pathToFileURL } from 'node:url';

// Resolving from a file in /usr/local/lib looks in /usr/local/lib/node_modules, where `npm install -g` puts them.
const GLOBAL_PARENT = pathToFileURL('/usr/local/lib/globals.mjs').href;
const BARE = /^(?![./]|[a-z][a-z0-9+.-]*:)/i;

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !BARE.test(specifier)) throw error;
    return next(specifier, { ...context, parentURL: GLOBAL_PARENT });
  }
}
