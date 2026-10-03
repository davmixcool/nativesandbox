# nativesandbox-browser: everything in the node-python image, plus headless Chromium driven by Playwright, and axe.
#
# Debian rather than Alpine: Playwright's Chromium is built against glibc and Playwright does not support musl.
# Only the headless shell is installed — the build `chromium.launch()` uses. Full Chromium (~390 MB) is for headed
# runs and tools that need a desktop Chrome, which a sandbox has no use for.
#
# The packages are global, so a script in the workspace can use them without an `npm install`, which would
# download a browser on every run. NODE_PATH serves require(); ESM import ignores NODE_PATH, so a resolve hook
# (globals.mjs) retries a bare import there once normal resolution has failed. Not a /node_modules link: npm
# takes the first parent holding node_modules as the project, so `npm i` in an empty workspace would install into /.
FROM node:22-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.63.0
ARG AXE_PLAYWRIGHT_VERSION=4.13.0

LABEL org.opencontainers.image.source="https://github.com/davmixcool/nativesandbox" \
      org.opencontainers.image.description="nativesandbox browser image: the node-python image plus Playwright headless Chromium and axe" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Three layers, so a Playwright bump rebuilds only the last two.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git curl ca-certificates \
 && ln -sf /usr/bin/python3 /usr/local/bin/python \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --omit=dev "playwright@${PLAYWRIGHT_VERSION}" "@axe-core/playwright@${AXE_PLAYWRIGHT_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Playwright's dependency list is the same for full and headless Chromium, and includes xvfb: a virtual display
# only headed runs use. On Debian it pulls in Mesa's drivers and LLVM (~150 MB) that the headless build never
# loads, so it is purged, with whatever only it needed, in the same layer.
RUN playwright install --with-deps --only-shell chromium \
 && apt-get purge -y --auto-remove xvfb \
 && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# A fixed path for tools that bring their own driver (puppeteer-core) and look for Chrome in CHROME_PATH. Chromium
# runs as root here, so they must pass --no-sandbox; Playwright already does (chromiumSandbox: false).
# The build fails here if anything the headless binary links against is missing.
RUN ln -sf "$(find /ms-playwright -type f \( -name chrome-headless-shell -o -name headless_shell \) | head -n 1)" /usr/local/bin/chromium \
 && ! ldd /usr/local/bin/chromium | grep "not found" \
 && /usr/local/bin/chromium --version
ENV CHROME_PATH=/usr/local/bin/chromium

COPY globals.mjs globals-hooks.mjs /usr/local/lib/nativesandbox/
ENV NODE_OPTIONS=--import=/usr/local/lib/nativesandbox/globals.mjs

WORKDIR /workspace
