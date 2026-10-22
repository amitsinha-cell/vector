import { useEffect, useState } from "react";
import { Logo } from "./Logo";

export function Splash({ onDone }: { onDone: () => void }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setP((v) => Math.min(100, v + 4 + Math.random() * 9)), 90);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (p >= 100) {
      const t = setTimeout(onDone, 350);
      return () => clearTimeout(t);
    }
  }, [p, onDone]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-background">
      <div className="flex flex-col items-center gap-4 animate-rise">
        <Logo className="h-20 w-20" />
        <h1 className="text-5xl font-semibold tracking-tight">
          <span className="text-brand">vector</span>
        </h1>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">local code intelligence</p>
      </div>
      <div className="w-64 animate-rise" style={{ animationDelay: "0.15s" }}>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand transition-[width] duration-150" style={{ width: `${p}%` }} />
        </div>
        <p className="mt-2 text-center font-mono text-[11px] text-muted-foreground">
          {p < 40 ? "warming up runtime" : p < 80 ? "connecting local models" : "ready"} · {Math.floor(p)}%
        </p>
      </div>
    </div>
  );
}
