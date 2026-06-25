# Claude Design Exporter — container image.
# Uses a plain Node base and lets Playwright install the Chromium build that matches
# the pinned playwright version, plus its system libraries. sharp ships prebuilt
# libvips binaries, so no extra apt packages are needed for image conversion.
FROM node:20-bookworm-slim

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install the matching Chromium + its OS dependencies for headless capture.
RUN npx playwright install --with-deps chromium

# App source (node_modules/out/uploads are excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
# Bind all interfaces inside the container; the platform maps $PORT. Put this behind
# auth (BASIC_AUTH_USER/PASS) when exposed — the app has no auth otherwise.
ENV HOST=0.0.0.0
ENV PORT=4178
EXPOSE 4178

CMD ["node", "server.mjs"]
