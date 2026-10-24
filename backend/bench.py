"""Benchmark script for local models.

Runs sample files through configured models (default, light, deep) and
outputs a markdown table of:
- Time per file
- Tokens/sec
- Peak VRAM (via nvidia-smi)
- Cache hit time
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import time
from pathlib import Path

import httpx

SAMPLE_FILES = [
    (
        "small_python.py",
        '''"""A simple math and utility library."""
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b

def fibonacci(n: int) -> list[int]:
    """Return the first n Fibonacci numbers."""
    if n <= 0:
        return []
    res = [0, 1]
    while len(res) < n:
        res.append(res[-1] + res[-2])
    return res[:n]

class Calculator:
    def __init__(self, precision: int = 2):
        self.precision = precision

    def divide(self, a: float, b: float) -> float:
        if b == 0:
            raise ValueError("Division by zero")
        return round(a / b, self.precision)
''',
    ),
    (
        "typescript_component.tsx",
        '''import React, { useState, useEffect } from "react";

interface UserProfileProps {
  userId: string;
  onUpdate?: (name: string) => void;
}

export function UserProfile({ userId, onUpdate }: UserProfileProps) {
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        if (active) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
    return () => { active = false; };
  }, [userId]);

  if (loading) return <div>Loading profile...</div>;
  if (!user) return <div>User not found</div>;

  return (
    <div className="profile-card">
      <h2>{user.name}</h2>
      <button onClick={() => onUpdate?.(user.name)}>Refresh</button>
    </div>
  );
}
''',
    ),
]


def get_gpu_vram() -> int | None:
    """Query current GPU memory usage in MB via nvidia-smi."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        )
        lines = out.decode().strip().splitlines()
        if lines:
            return int(lines[0].strip())
    except Exception:
        pass
    return None


async def benchmark_file(
    api_url: str,
    filename: str,
    content: str,
    model: str,
) -> dict:
    """Run cold and warm summarisation for a file and return metrics."""
    # Peak VRAM monitoring
    peak_vram = get_gpu_vram() or 0

    # Cold run
    t0 = time.perf_counter()
    tokens_received = 0

    async with httpx.AsyncClient(timeout=120.0) as client:
        # Force = true to bypass cache
        body = {"text": content, "filename": filename, "model": model, "force": True}
        async with client.stream("POST", f"{api_url}/summarize", json=body) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}")
            async for line in resp.aiter_lines():
                if "token" in line:
                    tokens_received += 1
                curr_vram = get_gpu_vram()
                if curr_vram and curr_vram > peak_vram:
                    peak_vram = curr_vram

    cold_time = time.perf_counter() - t0
    tokens_per_sec = tokens_received / cold_time if cold_time > 0 else 0

    # Cache hit run (force = false)
    t1 = time.perf_counter()
    async with httpx.AsyncClient(timeout=10.0) as client:
        body = {"text": content, "filename": filename, "model": model, "force": False}
        async with client.stream("POST", f"{api_url}/summarize", json=body) as resp:
            async for _ in resp.aiter_lines():
                pass
    cache_time = time.perf_counter() - t1

    return {
        "model": model,
        "file": filename,
        "cold_time": round(cold_time, 2),
        "tokens_per_sec": round(tokens_per_sec, 1),
        "peak_vram_mb": peak_vram,
        "cache_time": round(cache_time, 3),
    }


async def main():
    parser = argparse.ArgumentParser(description="Vector Model Benchmark")
    parser.add_argument("--url", default="http://localhost:8000", help="Vector backend URL")
    parser.add_argument("--models", nargs="*", default=["gemma4:e4b", "gemma4:e2b", "qwen2.5-coder:7b"])
    args = parser.parse_args()

    print(f"Benchmarking models: {args.models} on {args.url}\n")
    results = []

    for model in args.models:
        for fname, content in SAMPLE_FILES:
            try:
                print(f"Testing {model} on {fname}...")
                metrics = await benchmark_file(args.url, fname, content, model)
                results.append(metrics)
            except Exception as exc:
                print(f"Failed {model} on {fname}: {exc}")
                results.append({
                    "model": model,
                    "file": fname,
                    "cold_time": "ERR",
                    "tokens_per_sec": "ERR",
                    "peak_vram_mb": "ERR",
                    "cache_time": "ERR",
                })

    # Render Markdown table
    print("\n## Benchmark Results\n")
    print("| Model | File | Cold Time (s) | Tokens/s | Peak VRAM (MB) | Cache Hit Time (s) |")
    print("| :--- | :--- | :--- | :--- | :--- | :--- |")
    for r in results:
        print(f"| `{r['model']}` | `{r['file']}` | {r['cold_time']} | {r['tokens_per_sec']} | {r['peak_vram_mb']} | {r['cache_time']} |")


if __name__ == "__main__":
    asyncio.run(main())
