FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.26 /uv /uvx /bin/
COPY --from=node:24-slim /usr/local/bin /usr/local/bin
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node:24-slim /usr/local/include /usr/local/include
COPY --from=node:24-slim /usr/local/share /usr/local/share

WORKDIR /app

ENV TZ=Asia/Shanghai \
    UV_PROJECT_ENVIRONMENT=/usr/local \
    UV_COMPILE_BYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

RUN npm config set registry https://registry.npmmirror.com --global \
    && npm cache clean --force

RUN set -eux; \
    sed -i \
      -e 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; \
    echo "$TZ" > /etc/timezone; \
    apt-get update; \
    apt-get install -y --no-install-recommends --fix-missing \
      curl \
      ffmpeg \
      fonts-liberation \
      fonts-noto-cjk \
      git \
      libpq5 \
      libsm6 \
      libxext6 \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      libreoffice-writer-nogui; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml /app/pyproject.toml
COPY backend/.python-version /app/.python-version
COPY backend/uv.lock /app/uv.lock
COPY backend/package /app/package

RUN uv sync --no-cache --group test --no-dev --frozen

COPY backend/server /app/server
