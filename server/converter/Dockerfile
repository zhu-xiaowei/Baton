# Slide preview converter: LibreOffice Impress (no GUI) + metric-compatible and CJK fonts.
FROM public.ecr.aws/docker/library/debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress-nogui python3 python3-pip \
      fonts-noto-cjk fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 \
 && pip3 install --break-system-packages --no-cache-dir awslambdaric boto3 \
 && rm -rf /var/lib/apt/lists/*
COPY fonts.conf /etc/fonts/conf.d/65-baton-cjk.conf
RUN fc-cache -f
WORKDIR /opt/app
COPY handler.py warmup.fodp ./
ENTRYPOINT ["/usr/bin/python3", "-m", "awslambdaric"]
CMD ["handler.handler"]
