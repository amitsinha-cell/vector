"""Custom exceptions with structured error codes for Vector."""

from __future__ import annotations


class VectorError(Exception):
    code: str = "VECTOR_ERROR"

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code
        self.message = message


class OllamaDownError(VectorError):
    code: str = "OLLAMA_DOWN"


class ModelNotFoundError(VectorError):
    code: str = "MODEL_NOT_FOUND"


class OllamaTimeoutError(VectorError):
    code: str = "TIMEOUT"


class OutOfMemoryError(VectorError):
    code: str = "OUT_OF_MEMORY"


class ValidationError(VectorError):
    code: str = "VALIDATION_ERROR"
