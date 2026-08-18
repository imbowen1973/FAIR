# FAIR pull-and-render server (middle layer v0).
#
# Serves the assembler task pane and /api/pull: paste a public git URL,
# the server clones the markdown and renders slides at point of use.
# Nothing rendered is stored in the image or published — the example
# corpus and pulled libraries are rendered at container start / on
# request into ephemeral container storage.
#
#   docker build -t fair-server .
#   docker run -p 3000:3000 fair-server
#
# Put TLS in front (docs/deploy-server.md) — Office add-ins require HTTPS.

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY renderer/ renderer/
COPY scripts/ scripts/
COPY assembler/ assembler/
COPY examples/ examples/

RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir ./renderer

ENV FAIR_PYTHON=/app/.venv/bin/python \
    FAIR_BIND=0.0.0.0 \
    PORT=3000 \
    GIT_TERMINAL_PROMPT=0

EXPOSE 3000

# Render the bundled example corpus at start (ephemeral, per-container),
# then serve. Pulled libraries render on demand via /api/pull.
CMD ["/bin/sh", "-c", "/app/.venv/bin/python scripts/build_corpus.py && node assembler/server.mjs"]
