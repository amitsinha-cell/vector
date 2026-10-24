# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

# Install system deps needed by tree-sitter language pack
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ make \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python deps first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Data dir for the SQLite database (mounted as a volume)
RUN mkdir -p /data

ENV DB_PATH=/data/vector.db \
    HOST=0.0.0.0 \
    PORT=8000

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", \
     "--log-level", "info"]
