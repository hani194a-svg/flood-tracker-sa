"""Shared PostgreSQL connection for the analysis scripts (reads DATABASE_URL, like the backend)."""
import os

import psycopg


def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set (use the same value as backend/.env)")
    if os.environ.get("DATABASE_SSL") == "true" and "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return psycopg.connect(url)
