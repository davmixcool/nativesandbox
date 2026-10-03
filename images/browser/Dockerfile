# nativesandbox-browser: everything in the node-python image, plus Chromium driven by Playwright, axe and Lighthouse.
#
# Debian rather than Alpine: Playwright's Chromium is built against glibc and Playwright does not support musl.
# The packages are global, so a script in the workspace can use them without an `npm install`, which would
# download a browser on every run. NODE_PATH serves require(); ESM import ignores NODE_PATH, so the same
# directory is also linked at /node_modules, which resolution reaches walking up from /workspace.
FROM node:22-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.63.0
ARG AXE_PLAYWRIGHT_VERSION=4.13.0
ARG LIGHTHOUSE_VERSION=13.5.0

LABEL org.opencontainers.image.source="https://github.com/davmixcool/nativesandbox" \
      org.opencontainers.image.description="nativesandbox browser image: the node-python image plus Playwright Chromium, axe and Lighthouse" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git curl ca-certificates \
 && ln -sf /usr/bin/python3 /usr/local/bin/python \
 && npm install -g --omit=dev \
      "playwright@${PLAYWRIGHT_VERSION}" \
      "@axe-core/playwright@${AXE_PLAYWRIGHT_VERSION}" \
      "lighthouse@${LIGHTHOUSE_VERSION}" \
 && playwright install --with-deps chromium \
 && ln -sf "$(node -e "process.stdout.write(require('playwright').chromium.executablePath())")" /usr/local/bin/chromium \
 && ln -s /usr/local/lib/node_modules /node_modules \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# Lighthouse finds Chrome here. Chromium runs as root inside the sandbox, so it needs --no-sandbox; Playwright
# passes it by default (chromiumSandbox: false), Lighthouse needs --chrome-flags="--headless --no-sandbox".
ENV CHROME_PATH=/usr/local/bin/chromium

WORKDIR /workspace
