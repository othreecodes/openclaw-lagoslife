#!/usr/bin/env node
// Lagos Life MCP server (stdio, zero-dependency).
// Gives an agent live awareness of its Lagos Life character and a few safe actions.
// Auth via env: LL_USERNAME, LL_PASSWORD. Money sends are hard-capped at LL_MAX_SEND_PCT% of balance.

const BASE = "https://lagoslife.app";
const USERNAME = process.env.LL_USERNAME || "";
const PASSWORD = process.env.LL_PASSWORD || "";
const MAX_SEND_PCT = Math.max(0, Math.min(100, Number(process.env.LL_MAX_SEND_PCT || "10")));
const MIN_SEND = Math.max(0, Number(process.env.LL_MIN_SEND || "10000000"));

let cookie = "";
let me = null;

async function req(path, init) {
  const headers = { "content-type": "application/json", origin: BASE, ...(init && init.headers) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...init, headers });
  const setc = res.headers.get("set-cookie");
  if (setc) for (const c of setc.split(/,(?=\s*ll_)/)) cookie = (cookie ? cookie + "; " : "") + c.split(";")[0].trim();
  return res;
}

async function ensureLogin() {
  if (me) return;
  const r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
  if (!r.ok) throw new Error("Lagos Life login failed: HTTP " + r.status);
  const m = await req("/api/auth/me");
  if (m.ok) me = (await m.json()).user || null;
}

async function getGame() {
  await ensureLogin();
  const r = await req("/api/save");
  if (r.status === 401) { me = null; cookie = ""; await ensureLogin(); return getGame(); }
  if (!r.ok) throw new Error("save read failed: HTTP " + r.status);
  return (await r.json()).game || {};
}

const naira = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");
const pct = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${Math.round(Number(v))}%`).join(", ");

// ----- tool implementations (return a plain string) -----
async function toolStatus() {
  const g = await getGame();
  const mood = (g.moodlets || []).map((m) => `${m.emoji || ""}${m.label || ""}`.trim()).filter(Boolean).join(", ") || "neutral";
  const job = g.job && g.job.title ? g.job.title : (g.work && g.work.title) || "no job";
  const topSkills = Object.entries(g.skills || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(Number(v))}`).join(", ");
  return [
    `You are @${(me && me.username) || USERNAME}${me && me.name ? " (" + me.name + ")" : ""}.`,
    `Money: ${naira(g.money)}  |  Blessings: ${g.blessings ?? 0}`,
    `Location: ${g.location || "unknown"}  |  Home: ${g.home || "unknown"}  |  Weather: ${g.weather || "?"}`,
    `Needs: ${pct(g.needs)}`,
    `Mood: ${mood}`,
    `Job: ${job}`,
    `Top skills: ${topSkills || "none"}`,
    g.rentOwed ? `Rent owed: ${naira(g.rentOwed)}` : "",
    g.loan && g.loan.owed ? `Loan owed: ${naira(g.loan.owed)}` : "",
  ].filter(Boolean).join("\n");
}

async function toolBalance() {
  const g = await getGame();
  const cap = Math.floor((g.money || 0) * MAX_SEND_PCT / 100);
  const can = cap >= MIN_SEND;
  return `Balance: ${naira(g.money)}. ` + (can
    ? `A single gift must be between ${naira(MIN_SEND)} and ${naira(cap)} (10% of balance).`
    : `Too low to gift right now — needs at least ${naira(MIN_SEND * 10)} for a ${naira(MIN_SEND)} minimum transfer.`);
}

async function toolNotices(limit) {
  const g = await getGame();
  const n = (g.notices || []).slice(-(limit || 8)).reverse();
  if (!n.length) return "No recent notices.";
  return n.map((x) => `${x.emoji || "•"} ${x.text}`).join("\n");
}

async function toolSendMoney(to, amount) {
  if (!to || !/^[0-9a-f]{12,}$/i.test(String(to))) throw new Error("Need the recipient's user id (20-hex). Get it from the chat event or your contacts, not a username.");
  const g = await getGame();
  const cap = Math.floor((g.money || 0) * MAX_SEND_PCT / 100);
  if (cap < MIN_SEND) throw new Error(`Can't send now: ${MAX_SEND_PCT}% of your balance (${naira(cap)}) is under the ${naira(MIN_SEND)} minimum transfer.`);
  const requested = Math.floor(Number(amount) || 0);
  const amt = Math.min(Math.max(requested, MIN_SEND), cap); // clamp to [MIN_SEND, cap]
  const r = await req("/api/send", { method: "POST", body: JSON.stringify({ to, amount: amt }) });
  if (!r.ok) throw new Error("send failed: HTTP " + r.status);
  const j = await r.json();
  const adj = amt !== requested ? ` (adjusted from ${naira(requested)} to fit the ${naira(MIN_SEND)}–${naira(cap)} range)` : "";
  return `Sent ${naira(amt)}${adj}. Fee ${naira(j.fee || 0)}. ok=${j.ok}`;
}

async function toolSendMessage(to, body) {
  if (!to || !body) throw new Error("Need recipient id and message body.");
  const r = await req("/api/messages", { method: "POST", body: JSON.stringify({ to, body: String(body) }) });
  if (!r.ok) throw new Error("message failed: HTTP " + r.status);
  return "Message sent.";
}

const TOOLS = [
  { name: "lagoslife_status", description: "Your Lagos Life character's live status: money, location, home, needs, mood, job and top skills. Call this when you need to know anything about yourself in the game.", inputSchema: { type: "object", properties: {} },
    run: () => toolStatus() },
  { name: "lagoslife_balance", description: "How much in-game money you have right now, and the most you may gift in one transfer.", inputSchema: { type: "object", properties: {} },
    run: () => toolBalance() },
  { name: "lagoslife_notices", description: "Your recent in-game event feed (money received, gifts, happenings).", inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many recent notices (default 8)" } } },
    run: (a) => toolNotices(a && a.limit) },
  { name: "lagoslife_send_money", description: `Send in-game money to a player by user id. Every transfer is clamped to between ${naira(MIN_SEND)} (minimum) and ${MAX_SEND_PCT}% of your current balance (maximum). Only use when it genuinely fits — never for begging or scams.`, inputSchema: { type: "object", properties: { to: { type: "string", description: "Recipient user id (20-hex)" }, amount: { type: "number", description: `Whole naira (min ${MIN_SEND})` } }, required: ["to", "amount"] },
    run: (a) => toolSendMoney(a && a.to, a && a.amount) },
  { name: "lagoslife_send_message", description: "Send a direct message to a player by user id.", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] },
    run: (a) => toolSendMessage(a && a.to, a && a.body) },
];

// ----- minimal MCP stdio JSON-RPC (newline-delimited) -----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "lagoslife", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") { reply(id, {}); return; }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    return;
  }
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) { fail(id, -32602, "Unknown tool: " + (params && params.name)); return; }
    try {
      const text = await t.run((params && params.arguments) || {});
      reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (e) {
      reply(id, { content: [{ type: "text", text: "Error: " + String(e && e.message ? e.message : e) }], isError: true });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, "Method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e)); });
  }
});
process.stdin.on("end", () => process.exit(0));
