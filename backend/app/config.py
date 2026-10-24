"""Application configuration loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All config is read from env / .env file. Never hardcode model names in logic."""

    # Ollama
    ollama_url: str = "http://127.0.0.1:11434"
    default_model: str = "gemma4:e4b"
    light_model: str = "gemma4:e2b"
    deep_model: str = "qwen2.5-coder:7b"
    num_ctx: int = 4096

    # GitHub
    github_token: str = ""

    # Database
    db_path: str = "vector.db"

    # CORS / binding
    frontend_origin: str = "http://127.0.0.1:5173"
    cors_origins: str = ""
    host: str = "0.0.0.0"
    port: int = 8000

    # Prompt version — bump to invalidate all caches
    prompt_version: int = 1

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    def get_num_ctx(self, model: str | None = None) -> int:
        """Resolve context window based on model."""
        if not model:
            return self.num_ctx
        model_lower = model.lower()
        if "e2b" in model_lower:
            return 8192
        if "e4b" in model_lower:
            return 4096
        return self.num_ctx


# Singleton loaded once at startup
settings = Settings()

