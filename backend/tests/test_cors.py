"""Tests for CORS preflight and allowed origins."""

import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.parametrize("origin", [
    "http://localhost:5173",
    "http://localhost:8081",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8081",
    "http://192.168.1.100:5173",
    "http://10.0.0.5:5173",
])
@pytest.mark.parametrize("path,method", [
    ("/health", "GET"),
    ("/history", "GET"),
    ("/watch", "POST"),
    ("/summarize", "POST"),
])
def test_cors_preflight_allowed_origins(client, origin, path, method):
    """Test CORS OPTIONS preflight succeeds with 200 and proper headers for any local port."""
    headers = {
        "Origin": origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type",
    }
    response = client.options(path, headers=headers)
    assert response.status_code == 200, f"Preflight failed for {origin} on {path}: {response.text}"
    assert response.headers.get("access-control-allow-origin") == origin
    assert "access-control-allow-methods" in response.headers


def test_cors_preflight_disallowed_origin(client):
    """Test that unauthorized foreign origins are rejected."""
    headers = {
        "Origin": "http://evil-attacker.com",
        "Access-Control-Request-Method": "POST",
    }
    response = client.options("/health", headers=headers)
    assert response.status_code == 400


def test_health_endpoint_structure(client):
    """Test GET /health always returns 200 with expected structure."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["backend"] is True
    assert "ollama" in data
    assert "models" in data
    assert "defaults" in data
    assert "hosted_enabled" in data
