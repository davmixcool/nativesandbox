# nativesandbox-node-python: node and python in one image, so a job that edits with a python script and builds with npm
# runs in one sandbox instead of two.
FROM node:22-alpine3.24

LABEL org.opencontainers.image.source="https://github.com/davmixcool/nativesandbox" \
      org.opencontainers.image.description="nativesandbox node-python image: Node 22 + Python 3 + git + curl on Alpine" \
      org.opencontainers.image.licenses="Apache-2.0"

# A sandbox is disposable, so pip may install into the system Python (PEP 668 would refuse).
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apk add --no-cache python3 py3-pip git curl \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /workspace
