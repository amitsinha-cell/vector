// Local model client (Ollama-compatible API).
import type { Message, Source } from "./store";

export interface LocalModel { name: string; size?: number }

export async function listModels(endpoint: string): Promise<LocalModel[]> {
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`);
  if (!res.ok) throw new Error(`Model server responded ${res.status}`);
  const data = await res.json();
  return (data.models ?? []).map((m: { name: string; size?: number }) => ({ name: m.name, size: m.size }));
}

function sourceBlock(s: Source) {
  if (s.kind === "image") return `[Image attached: ${s.name}]`;
  if (s.kind === "link" && !s.content) return `[Link: ${s.url}]`;
  return `### ${s.name}${s.url ? ` (${s.url})` : ""}\n\`\`\`\n${(s.content ?? "").slice(0, 60000)}\n\`\`\``;
}

export async function streamSummary(opts: {
  endpoint: string;
  model: string;
  system: string;
  history: Message[];
  sources: Source[];
  signal: AbortSignal;
  onToken: (t: string) => void;
}) {
  const { endpoint, model, system, history, sources, signal, onToken } = opts;
  const last = history[history.length - 1];
  const used = sources.filter((s) => last.sourceIds?.includes(s.id));
  const images = used.filter((s) => s.kind === "image" && s.content).map((s) => s.content!.split(",")[1]);
  const ctx = used.filter((s) => s.kind !== "image").map(sourceBlock).join("\n\n");
  const messages = [
    { role: "system", content: system },
    ...history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: (ctx ? `Code to summarise:\n\n${ctx}\n\n` : "") + (last.content || "Summarise the provided code."),
      ...(images.length ? { images } : {}),
    },
  ];
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Model server responded ${res.status}: ${await res.text().catch(() => "")}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.message?.content) onToken(j.message.content);
    }
  }
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|scala|sh|sql|json|ya?ml|toml|md|vue|svelte|html|css|scss|lua|dart|r|ex|exs)$/i;

export async function fetchGitHub(url: string): Promise<{ name: string; content: string }> {
  const u = new URL(url);
  if (u.hostname === "raw.githubusercontent.com") {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`GitHub responded ${r.status}`);
    return { name: u.pathname.split("/").pop() || url, content: await r.text() };
  }
  const [owner, repo, type, branch, ...rest] = u.pathname.replace(/^\//, "").split("/");
  if (!owner || !repo) throw new Error("Enter a GitHub repo or file URL");
  if (type === "blob") {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
    const r = await fetch(raw);
    if (!r.ok) throw new Error(`GitHub responded ${r.status}`);
    return { name: rest[rest.length - 1], content: await r.text() };
  }
  const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!meta.ok) throw new Error(`Repository not found (${meta.status})`);
  const ref = branch || (await meta.json()).default_branch;
  const prefix = type === "tree" ? rest.join("/") : "";
  const tree = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  if (!tree.ok) throw new Error(`Couldn't read repository (${tree.status})`);
  const files = ((await tree.json()).tree as { path: string; type: string; size?: number }[])
    .filter((f) => f.type === "blob" && CODE_EXT.test(f.path) && f.path.startsWith(prefix) && (f.size ?? 0) < 100000)
    .slice(0, 25);
  const parts = await Promise.all(
    files.map(async (f) => {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${f.path}`);
      return r.ok ? `// FILE: ${f.path}\n${await r.text()}` : "";
    }),
  );
  return { name: `${owner}/${repo}${prefix ? "/" + prefix : ""}`, content: parts.filter(Boolean).join("\n\n") };
}
