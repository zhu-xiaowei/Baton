# Stage 1: build web frontend with Vite (no host node dependency required)
FROM public.ecr.aws/docker/library/node:20-alpine AS web-builder
WORKDIR /build
COPY package.json package-lock.json vite.config.js ./
RUN npm ci --no-audit --no-fund
COPY web/ web/
RUN npm run build

# Stage 2: Python Lambda runtime
FROM public.ecr.aws/docker/library/python:3.12-alpine
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
COPY requirements.txt .
COPY main.py .
COPY bridge_sync.py .
COPY bridge_read.py .
COPY bridge_ws.py .
COPY --from=web-builder /build/dist web/
RUN pip install --no-cache-dir -r requirements.txt

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

CMD ["python", "main.py"]
