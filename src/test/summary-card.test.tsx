import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SummaryCard } from "../components/vector/SummaryCard";
import type { SummaryResult } from "../lib/api";

const mockResult: SummaryResult = {
  id: 1,
  cached: false,
  model: "gemma4:e4b",
  provider: "ollama",
  summary: {
    tldr: "Calculates factorial and fibonacci sequences efficiently.",
    purpose: "Math utility module for combinatorial calculations.",
    language: "python",
    key_functions: [
      {
        name: "factorial",
        signature: "factorial(n: int) -> int",
        summary: "Computes n! using iterative algorithm.",
        line_start: 10,
        line_end: 18,
      },
      {
        name: "fibonacci",
        signature: "fibonacci(n: int) -> list[int]",
        summary: "Generates list of Fibonacci numbers up to n.",
        line_start: 20,
        line_end: 35,
      },
    ],
    dependencies: ["math", "typing"],
    gotchas: ["Does not handle negative input numbers."],
  },
};

describe("SummaryCard component", () => {
  it("renders TL;DR, Purpose, and Language badge", () => {
    render(<SummaryCard result={mockResult} />);

    expect(
      screen.getByText("Calculates factorial and fibonacci sequences efficiently."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Math utility module for combinatorial calculations."),
    ).toBeInTheDocument();
    expect(screen.getByText("python")).toBeInTheDocument();
  });

  it("renders key functions list and expands on click", () => {
    render(<SummaryCard result={mockResult} />);

    expect(screen.getByText("factorial")).toBeInTheDocument();
    expect(screen.getByText("fibonacci")).toBeInTheDocument();
    expect(screen.getByText("L10–18")).toBeInTheDocument();

    // Summary text is hidden initially until expanded
    expect(screen.queryByText("Computes n! using iterative algorithm.")).not.toBeInTheDocument();

    // Click function to toggle expansion
    const fnButton = screen.getByText("factorial").closest("button");
    fireEvent.click(fnButton!);

    // Summary text is now visible
    expect(screen.getByText("Computes n! using iterative algorithm.")).toBeInTheDocument();
  });

  it("renders dependencies chips and gotchas bullet items", () => {
    render(<SummaryCard result={mockResult} />);

    expect(screen.getByText("math")).toBeInTheDocument();
    expect(screen.getByText("typing")).toBeInTheDocument();
    expect(screen.getByText("Does not handle negative input numbers.")).toBeInTheDocument();
  });

  it("shows cached badge and calls onResummarise when clicked", () => {
    const onResummarise = vi.fn();
    const cachedResult = { ...mockResult, cached: true };

    render(<SummaryCard result={cachedResult} onResummarise={onResummarise} />);

    expect(screen.getByText(/Cached — file unchanged/i)).toBeInTheDocument();
    const resummariseBtn = screen.getByText(/Re-summarise/i);
    expect(resummariseBtn).toBeInTheDocument();

    fireEvent.click(resummariseBtn);
    expect(onResummarise).toHaveBeenCalledTimes(1);
  });

  it("shows Hosted badge when provider is hosted", () => {
    const hostedResult = { ...mockResult, provider: "hosted" };
    render(<SummaryCard result={hostedResult} />);

    expect(screen.getByText("Hosted")).toBeInTheDocument();
  });
});
