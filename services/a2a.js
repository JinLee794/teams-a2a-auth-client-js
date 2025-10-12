// src/app/a2a.js
import { A2AClient, createAuthenticatingFetchWithRetry, AuthenticationHandler } from "@a2a-js/sdk/client";

let client;
export function getA2A() {
  if (client) return client;

  const auth = new AuthenticationHandler(async () => {
    // Caller provides fresh OBO token per request
    throw new Error("inject-token-per-call");
  });

  const fetchWithRetry = createAuthenticatingFetchWithRetry(globalThis.fetch.bind(globalThis), auth, { retries: 3 });
  client = new A2AClient({
    baseUrl: process.env.A2A_BASE_URL,           // e.g., https://<logicapp-host>
    fetch: fetchWithRetry,                        // adds Authorization when auth.setToken is used
  });
  return client;
}