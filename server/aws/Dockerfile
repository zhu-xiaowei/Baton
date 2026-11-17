# Stage 1: build web frontend with Vite (no host node dependency required)
FROM public.ecr.aws/docker/library/node:20-alpine AS web-builder
WORKDIR /build
COPY package.json package-lock.json vite.config.js ./
RUN npm ci --no-audit --no-fund
COPY web/ web/
COPY bridge/ bridge/
RUN npm run build

# Stage 2: Node.js Lambda runtime (server/core + server/aws, no dependencies)
FROM public.ecr.aws/lambda/nodejs:22
COPY server/core/ server/core/
COPY server/aws/*.mjs server/aws/
COPY bridge/transfer-store.mjs bridge/
COPY --from=web-builder /build/dist web/
RUN chmod -R a+rX server bridge web

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

CMD ["server/aws/http-handler.handler"]
