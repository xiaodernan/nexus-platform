"""The agent tool registry (AGENT_CONTRACT §3) — the names first, the dispatch later.

`registry.py` — the ToolSpec registry and its `dispatch()` — is not built yet (filed). The
canonical tool NAMES live here, because two readers need them: the manifest at
`GET /ai/v1/tools` and the trust layer's tool-name scanner. Two hand-written copies of the
list are two lists, and they differ — D496's scanner copy was missing eight of the
twenty-four tools, so a merchant document naming `summarize_reviews` was not flagged at
all.

So the names are ONE fact, in one place, and every reader takes them from here.
"""

from nexus_ai.tools.names import (
    CANONICAL_TOOL_NAMES,
    NEVER_IN_DEFAULT_GRANT,
)

__all__ = ["CANONICAL_TOOL_NAMES", "NEVER_IN_DEFAULT_GRANT"]
