import { createRealtimeClient } from "@neon/realtime/client";

const apiBase = import.meta.env.VITE_API_URL || "/api";
const realtimeUrl = import.meta.env.VITE_NEON_REALTIME_URL;
const statusLine = document.querySelector("#status");
const rowsList = document.querySelector("#rows");
const insertForm = document.querySelector("#insert-form");
const insertButton = insertForm.querySelector("button");
const client = realtimeUrl ? createRealtimeClient({ url: realtimeUrl }) : null;
let accessToken = "";
let subscription;
let sealedQuery;
let renewalTimer;

const fetchSealedQuery = async () => {
  const response = await fetch(`${apiBase}/realtime-demo/live`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Could not renew sealed query (${response.status})`);
  return response.json();
};

const scheduleRenewal = () => {
  clearTimeout(renewalTimer);
  renewalTimer = setTimeout(async () => {
    try {
      const replacement = await fetchSealedQuery();
      await subscription.renew(replacement);
      sealedQuery = replacement;
      scheduleRenewal();
    } catch (error) {
      setStatus(error.message || "Could not renew the live query.");
    }
  }, Math.max(0, sealedQuery.expiresAt - Date.now() - 10000));
};

const setStatus = (message) => {
  statusLine.textContent = message;
};

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client) {
    setStatus("Realtime is not configured in this frontend build.");
    return;
  }

  const formData = new FormData(event.currentTarget);
  setStatus("Signing in and preparing the sealed query…");
  try {
    const login = await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });
    if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
    accessToken = (await login.json()).accessToken;

    sealedQuery = await fetchSealedQuery();

    subscription?.unsubscribe();
    subscription = client.subscribe(sealedQuery);
    scheduleRenewal();
    subscription.onChange(({ data, status, error }) => {
      setStatus(status === "error" ? `Live query stopped: ${error.message}` : `Subscription: ${status}`);
      rowsList.replaceChildren(...(data ?? []).map(({ id, value, createdAt }) => {
        const row = document.createElement("li");
        row.textContent = `${value} (${new Date(createdAt).toLocaleString()})`;
        row.dataset.id = id;
        return row;
      }));
      insertButton.disabled = status !== "live";
    });
    setStatus("Connecting to Neon Realtime…");
  } catch (error) {
    setStatus(error.message || "Could not start the live query.");
  }
});

insertForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!accessToken || !subscription) return;

  const button = insertButton;
  button.disabled = true;
  const value = new FormData(insertForm).get("value");
  try {
    const response = await fetch(`${apiBase}/realtime-demo`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) throw new Error(`Insert failed (${response.status})`);
    const result = await response.json();
    if (result.kind === "committed") {
      await subscription.awaitTxId(result.txid, 10000);
      setStatus("Committed change arrived through the live subscription.");
      insertForm.reset();
    }
  } catch (error) {
    setStatus(error.message || "Could not confirm the live change.");
  } finally {
    button.disabled = subscription.getState().status !== "live";
  }
});

window.addEventListener("beforeunload", () => {
  clearTimeout(renewalTimer);
  subscription?.unsubscribe();
  client?.close();
});
