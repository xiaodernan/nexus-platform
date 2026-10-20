"""HTTP surface for the NEXUS AI service — API_CONTRACT §7 + D13.

`app.py` is the uvicorn target; the route modules split by concern (search, stream,
discover, rag, conversations, system) all share one `Deps` instance and one SSE
serializer, so mock and live framing cannot drift apart.
"""

from __future__ import annotations
