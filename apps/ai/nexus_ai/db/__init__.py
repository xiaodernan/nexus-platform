"""Database access for the AI service (API_CONTRACT §0 role split)."""

from nexus_ai.db.pool import (
    Database,
    DatabaseUnavailable,
    InsufficientPrivilege,
    available,
    connect,
    db,
    dispose,
    require_db,
)

__all__ = ["Database", "DatabaseUnavailable", "InsufficientPrivilege", "connect", "db",
           "require_db", "dispose", "available"]
