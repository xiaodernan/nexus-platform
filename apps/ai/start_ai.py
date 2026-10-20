import os
os.environ['NEXUS_AI_DB_URL'] = 'postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus'
os.environ['NEXUS_REDIS_URL'] = 'redis://127.0.0.1:6380/0'
os.environ['NEXUS_LLM_PROVIDER'] = 'mock'
os.environ['NEXUS_JWT_SECRET'] = 'WzXNZUYCxxD18Uxtchua_gN66lmxaUFHvDH9THluD2fAz3HFGHKYQZHXA5vDWiSV'
os.environ['NEXUS_DEFAULT_TENANT'] = 'hong-kong'
os.environ['NEXUS_PLATFORM_BASE_URL'] = 'http://127.0.0.1:8090'
os.environ['NEXUS_AI_HOST_PORT'] = '8010'
os.chdir(r'D:\获客平台\apps\ai')
import uvicorn
uvicorn.run('app.main:app', host='127.0.0.1', port=8010, reload=False)