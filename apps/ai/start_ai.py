"""One-command local launch for the AI service.

Reads the environment with the same defaults the Makefile uses; nothing secret is carried
here (this file is tracked, and a tracked file is public). Anything you need to override —
database, Redis, model provider, host port — set it in the environment before running.

Usage:  uv run python start_ai.py        # serves :8010
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
os.environ.setdefault('NEXUS_AI_HOST_PORT', '8010')
os.chdir(Path(__file__).parent)

import uvicorn

uvicorn.run('app.main:app', host='127.0.0.1',
            port=int(os.environ['NEXUS_AI_HOST_PORT']), reload=False)
