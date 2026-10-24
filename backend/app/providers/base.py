"""Abstract base class for LLM providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator


class LLMProvider(ABC):
    """
    Provider interface.  Every implementation must support:
    - Streaming JSON output that conforms to a pydantic-compatible JSON schema.
    - Yielding partial tokens so the frontend can show progress.
    """

    name: str = "base"

    @abstractmethod
    async def stream_json(
        self,
        prompt: str,
        schema: dict[str, Any],
        model: str,
        *,
        system: str = "",
        num_ctx: int = 8192,
    ) -> AsyncIterator[str]:
        """
        Send a prompt to the model with a JSON-schema constraint.
        Yield raw text tokens as they arrive.
        The concatenation of all yielded tokens must form valid JSON
        matching *schema*.
        """
        ...  # pragma: no cover

    @abstractmethod
    async def is_available(self) -> bool:
        """Return True if the provider is reachable."""
        ...  # pragma: no cover

    @abstractmethod
    async def list_models(self) -> list[dict]:
        """Return a list of available models with metadata."""
        ...  # pragma: no cover
