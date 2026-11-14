# The deployment image for the AI service. Built by the `full` compose profile and CI.
#
# Rebuild path matches the services/cloud Docker recipe: the host builds with uv, the image
# carries the built venv — not the Python source alone — so the image's runtime never needs a
# network at start time and the smoke can boot a stack without reaching out.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /build
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
COPY nexus_ai nexus_ai
COPY app app
COPY start_ai.py ./
RUN uv sync --frozen --no-dev

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

WORKDIR /app
COPY --from=builder /build/.venv /app/.venv
COPY --from=builder /build/nexus_ai /app/nexus_ai
COPY --from=builder /build/app /app/app
COPY --from=builder /build/start_ai.py /app/start_ai.py
ENV PATH="/app/.venv/bin:${PATH}" \
    NEXUS_AI_HOST=0.0.0.0 \
    NEXUS_AI_PORT=8000
EXPOSE 8000
CMD ["python", "start_ai.py"]
