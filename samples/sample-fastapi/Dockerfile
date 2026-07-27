# FastAPI container (level 3), running on the devcontainer's own daemon.
# No secret is ever COPYed or ARGed here -- the container receives only a
# placeholder at runtime, and the VM proxy swaps in the real value in-flight.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" httpx
COPY app/ ./app/
# Trust the devenv-proxy CA (mounted at /devenv-ca) before serving, so outbound
# HTTPS through the intercepting proxy validates. No-op if the mount is absent.
RUN printf '#!/bin/sh\nset -e\n[ -x /devenv-ca/install-ca.sh ] && /devenv-ca/install-ca.sh >/dev/null 2>&1 || true\nexec "$@"\n' \
      > /usr/local/bin/with-ca && chmod +x /usr/local/bin/with-ca
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/with-ca"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
