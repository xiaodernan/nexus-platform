FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/types/package.json packages/types/package.json
RUN npm ci --prefer-offline --no-audit --no-fund
COPY apps/web apps/web
COPY packages packages
COPY docs/evidence docs/evidence

ARG NEXT_PUBLIC_DATA_MODE=live
ARG NEXT_PUBLIC_DEFAULT_GEO=22.3809,114.1861
ENV NEXT_PUBLIC_DATA_MODE=$NEXT_PUBLIC_DATA_MODE \
    NEXT_PUBLIC_DEFAULT_GEO=$NEXT_PUBLIC_DEFAULT_GEO
RUN npm run build --workspace @nexus/web && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@nexus/web"]
