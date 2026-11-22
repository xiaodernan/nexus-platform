"""One-command local launch for the AI service.

Reads the environment with the same defaults the Makefile uses; nothing secret is carried
here (this file is tracked, and a tracked file is public). Anything you need to override —
database, Redis, model provider, host port — set it in the environment before running.

Usage:  uv run python start_ai.py        # serves :8010

This file is also the container's CMD (apps/ai/Dockerfile), so every default below is a
`setdefault`: a value the image or the deployment declares wins, and nothing here seeds a
variable that belongs to the far side of a published port mapping (D1550).
"""
import os
from pathlib import Path

os.environ.setdefault('NEXUS_AI_DB_URL', os.environ.get(
    'NEXUS_DATABASE_URL',
    'postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus'))
os.environ.setdefault('NEXUS_REDIS_URL', 'redis://127.0.0.1:6380/0')
os.environ.setdefault('NEXUS_LLM_PROVIDER', 'mock')
os.environ.setdefault('NEXUS_DEFAULT_TENANT', 'hong-kong')
os.environ.setdefault('NEXUS_PLATFORM_BASE_URL', 'http://127.0.0.1:8090')
os.chdir(Path(__file__).parent)

import uvicorn

# The interface and the port are read from the same names the service itself documents
# (nexus_ai/config.py:122) and the same chain nexus_ai/discovery.py:94 registers with, so the
# socket, the registration and the image's EXPOSE can no longer disagree. NEXUS_AI_HOST_PORT is
# the HOST lane's knob (scripts/cloud_lb_smoke.sh) and stays undefaulted: inside a container it is
# the host side of the mapping, and binding it would answer a port nobody publishes.
uvicorn.run('app.main:app',
            host=os.environ.get('NEXUS_AI_HOST') or '127.0.0.1',
            port=int(os.environ.get('NEXUS_AI_HOST_PORT') or os.environ.get('NEXUS_AI_PORT') or '8010'),
            reload=False)
