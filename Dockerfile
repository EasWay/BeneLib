# Not pinned by digest, so each release build gets the latest Node 24 and Debian security fixes.
FROM node:24-slim
WORKDIR /app

# The browser is used for Z-Library searches without an account and for Anna's Archive. For a much
# smaller image without it, build with: docker compose build --build-arg WITH_BROWSER=0
ARG WITH_BROWSER=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN if [ "$WITH_BROWSER" = "1" ]; then \
        npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; \
    else \
        npm ci --omit=dev --omit=optional --ignore-scripts; \
    fi

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY supabase ./supabase

# BUILD_ID is the git commit, passed in by the publish workflow. It is shown in the admin panel under System.
ARG BUILD_ID=""
# HOME=/tmp: with PUID/PGID set to a user the image does not know, HOME would be /, which the browser cannot write to.
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data BOOKS_DIR=/books AUDIOBOOKS_DIR=/audiobooks BROWSER_IN_CONTAINER=1 PUBLIC_INSTANCE=1 TRUST_PROXY=1 ALLOWED_HOSTS=quietchapters.up.railway.app BUILD_ID=$BUILD_ID HOME=/tmp
# /data holds settings and the shelf list, /books and /audiobooks hold the files, /downloads is shared with qBittorrent.
RUN mkdir -p /data /books /audiobooks /downloads && chown -R node:node /data /books /audiobooks /downloads
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
