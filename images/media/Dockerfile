# nativesandbox-media: everything in the node-python image, plus ffmpeg and libvips for video and images.
FROM node:22-alpine3.24

LABEL org.opencontainers.image.source="https://github.com/davmixcool/nativesandbox" \
      org.opencontainers.image.description="nativesandbox media image: the node-python image plus ffmpeg and libvips" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apk add --no-cache python3 py3-pip git curl ffmpeg vips-tools \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /workspace
