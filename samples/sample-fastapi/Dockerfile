# FastAPI container (level 3), running on the devcontainer's own daemon.
# No secret is ever COPYed or ARGed here -- the container receives only a
# placeholder at runtime, and the VM proxy swaps in the real value in-flight.
FROM python:3.12-slim
WORKDIR /app
# Dependencies before source, so editing app/ does not reinstall them. They
# live in requirements.txt rather than inline here: an inline list and a
# requirements file would be two sources of truth that quietly disagree.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
