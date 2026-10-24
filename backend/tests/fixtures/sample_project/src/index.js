/**
 * Main application client entry point.
 */
export function startApp() {
  console.log("Sample project app started");
  return { initialized: true, timestamp: Date.now() };
}

export function fetchItems() {
  return fetch("/items/1").then((res) => res.json());
}
