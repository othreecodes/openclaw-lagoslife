import {
  defineChannelPluginEntry,
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

const CHANNEL_ID = "lagoslife";
const BASE = "https://lagoslife.app";
const DEFAULT_PERSONA =
  "You are a chill young Lagos guy hanging out on Lagos Life. Text like a real person: short, casual, lowercase is fine, use contractions and chat shorthand. Keep it English, not heavy Pidgin. Friendly and laid-back, never formal.";

type Account = {
  accountId: string | null;
  enabled: boolean;
  configured: boolean;
  username: string;
  password: string;
  persona: string;
  allowFrom?: string[];
  logEvents: boolean;
  // money / events
  allowSendMoney: boolean;
  quoteReplies: boolean; // quote the message being replied to (Lagos Life quoted bubble)
  maxSendPct: number; // hard cap: single transfer <= this % of current balance
  minSend: number; // floor: any transfer is at least this (default 1,000,000)
  sendCooldownMs: number; // min gap between transfers to the same person
  reactToSocial: boolean; // reply to bare waves/hellos/gists (noisy; off by default)
  replyDelayMinMs: number; // humanizing: random wait before a reply is sent
  replyDelayMaxMs: number;
  catchUpOnStart: boolean; // on startup, reply to chats left unanswered
  catchUpMax: number;
  catchUpStaggerMs: number;
  catchUpMinAgeMs: number; // only catch up threads idle at least this long (avoid double-replying the live queue)
  catchUpReplyAll: boolean; // ignore the ender/event skip filter and reply to every unanswered thread
};

function readSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return (channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): Account {
  const s = readSection(cfg);
  const username = typeof s.username === "string" ? s.username : "";
  const password = typeof s.password === "string" ? s.password : "";
  const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
  return {
    accountId: accountId ?? null,
    enabled: s.enabled !== false,
    configured: username.length > 0 && password.length > 0,
    username,
    password,
    persona: (typeof s.persona === "string" && (s.persona as string).trim()) || DEFAULT_PERSONA,
    allowFrom: Array.isArray(s.allowFrom) ? (s.allowFrom as string[]) : undefined,
    logEvents: s.logEvents === true,
    allowSendMoney: s.allowSendMoney !== false, // default on (user requested)
    quoteReplies: s.quoteReplies === true,
    maxSendPct: Math.max(0, Math.min(100, num(s.maxSendPct, 10))),
    minSend: Math.max(0, num(s.minSend, 10000000)), // never send below ₦10,000,000
    sendCooldownMs: Math.max(0, num(s.sendCooldownMs, 0)), // generous: no cooldown by default
    reactToSocial: s.reactToSocial === true,
    replyDelayMinMs: Math.max(0, num(s.replyDelayMinMs, 1000)),
    replyDelayMaxMs: Math.max(0, num(s.replyDelayMaxMs, 10000)),
    catchUpOnStart: s.catchUpOnStart === true,
    catchUpMax: Math.max(0, num(s.catchUpMax, 40)),
    catchUpStaggerMs: Math.max(1000, num(s.catchUpStaggerMs, 8000)),
    catchUpMinAgeMs: Math.max(0, num(s.catchUpMinAgeMs, 0)),
    catchUpReplyAll: s.catchUpReplyAll === true,
  };
}

// ----- Lagos Life client (websocket for inbound, REST for actions) -----
class LagosLifeClient {
  private cookie = "";
  me: { id: string; username: string; name?: string } | null = null;
  private ws: WebSocket | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: (m: string) => void,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: BASE,
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + path, { ...init, headers });
    const setc = res.headers.get("set-cookie");
    if (setc) {
      const incoming = setc.split(/,(?=\s*ll_)/).map((c) => c.split(";")[0].trim());
      const jar = new Map(
        this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const),
      );
      for (const c of incoming) jar.set(c.split("=")[0], c);
      this.cookie = [...jar.values()].join("; ");
    }
    return res;
  }

  async login(): Promise<void> {
    const r = await this.req("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!r.ok) throw new Error(`login failed: HTTP ${r.status}`);
    const meRes = await this.req("/api/auth/me");
    if (meRes.ok) {
      const body = (await meRes.json()) as { user?: { id: string; username: string; name?: string } };
      this.me = body.user ?? null;
    }
  }

  private async liveUrl(): Promise<string> {
    const r = await this.req("/api/live");
    if (!r.ok) throw new Error(`/api/live failed: HTTP ${r.status}`);
    const body = (await r.json()) as { url?: string };
    if (!body.url) throw new Error("/api/live returned no url");
    return body.url;
  }

  async connect(onMessage: (data: string) => void): Promise<void> {
    const url = await this.liveUrl();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.log(`lagoslife: connected as @${this.me?.username ?? this.username}`);
      this.pinger = setInterval(() => {
        try {
          ws.send("ping");
        } catch {
          /* ignore */
        }
      }, 25000);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data || data === "pong" || data === "ping") return;
      onMessage(data);
    });
    ws.addEventListener("close", () => {
      if (this.pinger) clearInterval(this.pinger);
      if (!this.stopped) {
        this.log("lagoslife: socket closed; reconnecting in 5s");
        setTimeout(() => void this.reconnect(onMessage), 5000);
      }
    });
    ws.addEventListener("error", (ev: Event) => {
      this.log(`lagoslife: socket error ${String((ev as { message?: string }).message ?? "")}`);
    });
  }

  private async reconnect(onMessage: (data: string) => void): Promise<void> {
    try {
      await this.login();
      await this.connect(onMessage);
    } catch (err) {
      this.log(`lagoslife: reconnect failed (${String(err)}); retrying in 10s`);
      setTimeout(() => void this.reconnect(onMessage), 10000);
    }
  }

  // Send a direct message. Lagos Life delivers inbound over the websocket but
  // sends replies via REST: POST /api/messages { to, body }.
  // POST with automatic retry on 429 (the game rate-limits writes).
  private async postRetry(path: string, payload: unknown, label: string): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.req(path, { method: "POST", body: JSON.stringify(payload) });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 2000 + attempt * 2500));
        continue;
      }
      if (!r.ok) throw new Error(`${label} failed: HTTP ${r.status}`);
      return r;
    }
    throw new Error(`${label} failed: HTTP 429 after retries`);
  }

  // replyToId quotes that message (Lagos Life shows it as a quoted bubble).
  async dm(toId: string, body: string, replyToId?: string): Promise<void> {
    if (!toId) throw new Error("lagoslife: missing recipient id");
    const payload = replyToId ? { to: toId, body, reply: replyToId } : { to: toId, body };
    await this.postRetry("/api/messages", payload, "send DM");
  }

  // Current wallet balance (whole naira). Parsed from GET /api/save.
  async balance(): Promise<number> {
    const r = await this.req("/api/save");
    if (!r.ok) throw new Error(`balance read failed: HTTP ${r.status}`);
    const txt = await r.text();
    const m = txt.match(/"money"\s*:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  // Transfer money: POST /api/send { to, amount }. Returns the server result.
  async sendMoney(toId: string, amount: number): Promise<{ ok: boolean; amount?: number; fee?: number }> {
    const r = await this.postRetry("/api/send", { to: toId, amount }, "send money");
    return (await r.json()) as { ok: boolean; amount?: number; fee?: number };
  }

  // Inbox: list of conversation threads. thread.id is the other player's user id.
  async getInbox(): Promise<Array<{ id: string; username: string; at?: number; unread?: number; last?: { body?: string; mine?: boolean } }>> {
    const r = await this.req("/api/messages");
    if (!r.ok) throw new Error(`inbox read failed: HTTP ${r.status}`);
    const j = (await r.json()) as { threads?: unknown };
    return Array.isArray(j.threads) ? (j.threads as Array<{ id: string; username: string; at?: number; unread?: number; last?: { body?: string; mine?: boolean } }>) : [];
  }

  stop(): void {
    this.stopped = true;
    if (this.pinger) clearInterval(this.pinger);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// Shared handle so the outbound sendText path can reach the live client.
let activeClient: LagosLifeClient | null = null;
// Per-sender cooldown for money transfers (anti-drain).
const lastSentAt = new Map<string, number>();

function stripPrefix(raw: string): string {
  return String(raw).trim().replace(/^lagoslife:/i, "");
}

// Outbound guard: never let agent/runtime meta-text or system notices reach the
// game chat. Only genuine in-character replies go out; anything matching these
// operational patterns is dropped.
const META_PATTERNS: RegExp[] = [
  /couldn['’]t confirm/i,
  /\bresend\b/i,
  /missing remainder/i,
  /previous (reply|message|turn)/i,
  /reach(ed|es)? (this )?chat/i,
  /\bas an ai\b/i,
  /\b(language|large) model\b/i,
  /\bI (cannot|can['’]t|am unable to|won['’]t|will not) (resend|confirm|verify|deliver|repeat)/i,
  /\b(tool|function) (call|result|output)\b/i,
  /\b(system|runtime|gateway|assistant) (message|notice|error)\b/i,
  /\bautomatically\b.*\b(resend|reply|send)/i,
  /\[.*\b(lagos life live chat|reply in character)\b.*\]/i, // the prompt itself echoed back
];
function isMetaLeak(text: string): boolean {
  return META_PATTERNS.some((p) => p.test(text));
}

// Make replies read like a real person texting: no em/en dashes or other AI
// punctuation tells, straight quotes, plain ellipsis.
function humanize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ") // em/en dash -> comma
    .replace(/…/g, "...")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*,/g, ",") // collapse any double comma the dash swap created
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Does an inbound message ask blaze for money? (Blaze is very generous and sends on request.)
const MONEY_REQUEST: RegExp[] = [
  /\b(send|dash|give|gift|transfer|drop|sponsor|spare|lend|borrow|credit|alert|wire|chop|fund|bless|sort|settle|run|load|add)\b.{0,30}\b(me|us|some|something|money|cash|funds?|change|naira|₦|\d|million|small)\b/i,
  /\b(abeg|please|pls|biko)\b.{0,30}\b(send|dash|money|cash|something|help|assist|bless|gift)\b/i,
  /\bi (need|want|dey find|dey look for|no get)\b.{0,20}\b(money|cash|funds?|help|something|change)\b/i,
  /\b(help|assist|settle|support|hook|sort)\b.{0,15}\b(me|us)\b.{0,20}\b(money|cash|something|small|na|abeg|up|out|love|\d)?\b/i,
  /\b(anything|something|money|cash|change|small)\b.{0,8}\bfor me\b/i,
  /\b(broke|hungry|stranded|no money|need money|need cash|hook me up|show me love|bless me|run me|borrow me|lend me)\b/i,
];
function isMoneyRequest(text: string): boolean {
  return MONEY_REQUEST.some((p) => p.test(text));
}

// Blaze refusing money is itself a signal that money was asked for.
const MONEY_REFUSAL: RegExp[] = [
  /\b(can'?t|cannot|won'?t|will not|no fit|not going to|unable to)\b.{0,25}\b(send|dash|give|gift|spare|fund|money|cash)\b/i,
  /\bi (no|don'?t|do not|never) (dey )?(dash|give|send|do)\b/i,
  /\bna you (get|dey hold|get am|get the money)\b/i,
  /\b(get your own|hustle (am|for|your)|work for (am|it)|earn (am|it))\b/i,
  /\bno money (to|for|wey)\b/i,
  /\b(not|no) (a |your )?(bank|atm|charity|santa)\b/i,
  /\b(maybe|next|another) (later|time)\b/i,
  /\b(we go|make we) hustle\b/i,
];
function isMoneyRefusal(text: string): boolean {
  return MONEY_REFUSAL.some((p) => p.test(text));
}

// Warm "yes" confirmations (also keep the convo going). Plain English, no pidgin, no em dashes.
const MONEY_CONFIRMS: string[] = [
  "Of course, just sent you something 🔥 enjoy it.",
  "I got you, the money just landed in your wallet 💸",
  "Anything for you, just sent some your way 🙏🏾",
  "No problem at all, just dropped something for you 💸 spend it well.",
  "Done, go check your wallet 🔥",
  "For you? Always. Just sent it over 💸",
  "Just sent you a little something to help out 🙏🏾 take care.",
];
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

type Inbound = {
  type: "chat" | "money" | "gift" | "social";
  text: string; // chat body, or the event sentence
  amount?: number; // money events
  fromId: string;
  fromName: string;
  id?: string;
  at?: number;
};

// Lagos Life frames (confirmed from live traffic):
//   chat:  { t:"msg", m:{ id, kind:"chat",   body, at, from, fromId } }
//   event: { t:"msg", m:{ id, kind:"social", body, at, from, fromId } }
//          e.g. "X sent you ₦1,000,000 💸", "X bought you suya 🍢",
//               "X said hello to you 👋", "X gisted with you 💬"
function extractEvent(frame: Record<string, unknown>): Inbound | null {
  if (frame.t !== "msg" || !frame.m || typeof frame.m !== "object") return null;
  const m = frame.m as Record<string, unknown>;
  const kind = m.kind;
  const body = typeof m.body === "string" ? m.body.trim() : "";
  if (!body) return null;
  const fromId = String(m.fromId ?? "");
  const fromName = String(m.from ?? m.fromId ?? "someone");
  const base = {
    fromId,
    fromName,
    id: typeof m.id === "string" ? m.id : undefined,
    at: typeof m.at === "number" ? m.at : undefined,
  };

  if (kind === "chat") return { type: "chat", text: body, ...base };

  if (kind === "social") {
    const money = body.match(/sent you ₦([\d,]+)/i);
    if (money) {
      return { type: "money", text: body, amount: Number(money[1].replace(/,/g, "")), ...base };
    }
    if (/\bbought you\b/i.test(body)) return { type: "gift", text: body, ...base };
    return { type: "social", text: body, ...base }; // wave / hello / gist
  }
  return null;
}

function fmtNaira(n: number): string {
  return "₦" + n.toLocaleString("en-NG");
}

async function startRuntime(api: OpenClawPluginApi): Promise<void> {
  const account = resolveAccount(api.config, null);
  if (!account.enabled || !account.configured) return;

  const client = new LagosLifeClient(account.username, account.password, (m) => api.logger.info(m));
  await client.login();
  activeClient = client;
  const selfId = client.me?.id ?? account.username;

  const payDocs = account.allowSendMoney
    ? `\nYou are extremely generous with money and you ALWAYS say yes. If anyone hints they want money, or asks you to send, dash, bless, or help them out, you immediately agree and gladly send them some. ` +
      `Never refuse, never say it is their money, never tell them to hustle or earn it, never say maybe later. The gift is sent for you automatically, so just reply warmly confirming it, like "say no more, just sent you something". ` +
      `You can also gift someone unprompted with a tag on its own line: <<pay AMOUNT>> (whole naira, e.g. <<pay 10000000>>). ` +
      `Every transfer is between ${fmtNaira(account.minSend)} and ${account.maxSendPct}% of your balance.`
    : "";

  const header = `[Lagos Life live chat. ${account.persona}\nYou are @${client.me?.username ?? account.username}.`;
  const tail =
    `Reply like a real person texting, not like an assistant. Keep it SHORT, usually a few words or one line, fragments are fine.\n` +
    `Text casually: lowercase is fine, use contractions (don't, i'm, you're, that's) and everyday chat shorthand (u, ur, rn, lol, lmao, ngl, tbh, fr, nah, yeah, bro, lowkey). You do not need perfect grammar or punctuation, and you usually do not end with a full stop. No em dashes, nothing polished, nothing poetic, no little essays. ` +
    `Keep it casual English texting, not Nigerian Pidgin (no "dey", "wetin", "abeg", "na", "wahala", "sabi", "sef", "o", "nko"). ` +
    `Just react: agree, joke, tease, relate, or vibe. Ask a question only once in a while, never two in a row, not every message. Do not interview people. ` +
    `Do not be the first to end the chat or say bye; let them wind it down. ` +
    `Match this vibe for length and tone: ` +
    `them "how was your day" -> you "chill honestly, just been indoors. u?"; ` +
    `them "i just got a new car" -> you "ohh congrats, what did u cop?"; ` +
    `them "i'm bored" -> you "same energy tbh lol"; ` +
    `them "lol you're funny" -> you "i try 😂".${payDocs}]`;

  const onMessage = (data: string): void => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      api.logger.info(`lagoslife: non-json frame ${data.slice(0, 200)}`);
      return;
    }
    const ev = extractEvent(frame);
    if (!ev) {
      if (account.logEvents) api.logger.info(`lagoslife: event ${data.slice(0, 220)}`);
      return;
    }
    if (ev.fromId && ev.fromId === selfId) return; // ignore our own
    if (
      account.allowFrom &&
      account.allowFrom.length > 0 &&
      !account.allowFrom.includes(ev.fromId) &&
      !account.allowFrom.includes(ev.fromName)
    ) {
      return;
    }
    // Bare waves / hellos / gists are noisy — ignore unless opted in.
    if (ev.type === "social" && !account.reactToSocial) {
      if (account.logEvents) api.logger.info(`lagoslife: ignored social from ${ev.fromName}: ${ev.text}`);
      return;
    }

    let situation: string;
    if (ev.type === "money") {
      situation = `${ev.fromName} just sent you ${fmtNaira(ev.amount ?? 0)} in the game as a money gift. Thank them warmly and naturally.`;
    } else if (ev.type === "gift") {
      situation = `${ev.fromName} just gave you a gift in the game ("${ev.text}"). Thank them briefly.`;
    } else if (ev.type === "social") {
      situation = `${ev.fromName} ${ev.text.replace(new RegExp("^" + ev.fromName + "\\s*", "i"), "")} Greet them back in one short line.`;
    } else {
      situation = `${ev.fromName} messaged you in the game.`;
    }

    const bodyForAgent = `${header} ${situation}\n${tail}\n\n${ev.type === "chat" ? ev.text : ev.text}`;
    const convId = ev.fromId || ev.fromName || "lagoslife";
    const moneyReq = ev.type === "chat" && isMoneyRequest(ev.text);

    void dispatchInboundDirectDmWithRuntime({
      runtime: api.runtime,
      cfg: api.config,
      channel: CHANNEL_ID,
      channelLabel: "Lagos Life",
      accountId: account.accountId ?? "default",
      peer: { kind: "direct", id: convId },
      senderId: ev.fromId || convId,
      senderAddress: `lagoslife:${convId}`,
      recipientAddress: `lagoslife:${selfId}`,
      conversationLabel: `${ev.fromName} (Lagos Life)`,
      rawBody: ev.text,
      bodyForAgent,
      messageId: ev.id ?? `${convId}:${Date.now()}`,
      timestamp: ev.at ?? Date.now(),
      inboundAccessAuthorized: true,
      deliver: async (payload: { text?: string }) => {
        let reply = payload.text?.trim();
        if (!reply) return;

        // Intercept a money-send directive: <<pay AMOUNT>>
        const payMatch = reply.match(/<<\s*pay\s+([\d,]+)\s*>>/i);
        let didPay = false;
        if (payMatch) {
          reply = reply.replace(payMatch[0], "").trim();
          if (account.allowSendMoney) {
            try {
              await maybeSendMoney(client, account, ev.fromId, ev.fromName, Number(payMatch[1].replace(/,/g, "")), api);
              didPay = true;
            } catch (err) {
              api.logger.error(`lagoslife: money send failed: ${String(err)}`);
            }
          }
        }
        // Always say yes to money: a detected request OR blaze's own refusal
        // both mean money was asked for. Send it, and never let a "no" go out.
        const refusing = isMoneyRefusal(reply);
        const wantsMoney = moneyReq || refusing;
        if (wantsMoney && account.allowSendMoney && !didPay) {
          try {
            await maybeSendMoney(client, account, ev.fromId, ev.fromName, account.minSend, api);
            didPay = true;
          } catch (err) {
            api.logger.error(`lagoslife: auto money send failed: ${String(err)}`);
          }
        }
        // If money was asked for AND sending is enabled, the outgoing line is a warm
        // yes. When sending is off, leave blaze's own reply so he never falsely claims
        // to have sent money.
        if (wantsMoney && account.allowSendMoney) {
          reply = pick(MONEY_CONFIRMS);
        }

        if (!reply) return; // reply was only the pay tag; the transfer itself is the message
        if (isMetaLeak(reply)) {
          api.logger.info(`lagoslife: BLOCKED non-game/runtime text to ${ev.fromName}: ${reply.slice(0, 100)}`);
          return;
        }
        reply = humanize(reply);
        if (!reply) return;
        // random human-like pause before replying
        const wait =
          account.replyDelayMinMs +
          Math.floor(Math.random() * Math.max(0, account.replyDelayMaxMs - account.replyDelayMinMs));
        if (wait > 0) await sleep(wait);
        // Quote the message we are replying to, but only for real live messages
        // (catch-up uses synthetic ids with no real message to quote).
        const quoteId =
          account.quoteReplies && ev.id && !ev.id.startsWith("catchup:") ? ev.id : undefined;
        try {
          await client.dm(ev.fromId, reply, quoteId);
          api.logger.info(`lagoslife: replied to ${ev.fromName} (after ${Math.round(wait / 1000)}s)${quoteId ? " [quoted]" : ""}: ${reply.slice(0, 80)}`);
        } catch (err) {
          api.logger.error(`lagoslife: reply send failed: ${String(err)}`);
        }
      },
    }).catch((err) => api.logger.error(`lagoslife: dispatch failed: ${String(err)}`));
  };

  await client.connect(onMessage);

  // One-time catch-up: replay chats left unanswered back through the same
  // pipeline so blaze replies in-character (persona + humanize + delay).
  if (account.catchUpOnStart) {
    void (async () => {
      await sleep(5000); // let the socket settle first
      try {
        const threads = await client.getInbox();
        const skipRe =
          /sent you ₦|said hello|gisted with you|bought you|waved|^\s*(thanks|thank you|ok|okay|k|kk|soon|now|cool|alright|no wam|nice one|bye|later|noted|received)\b/i;
        const pending = threads
          .filter((t) => t && t.last && t.last.mine === false && typeof t.last.body === "string" && t.id)
          .filter((t) => account.catchUpReplyAll || !skipRe.test((t.last!.body || "").trim()))
          .filter((t) => !account.catchUpMinAgeMs || !t.at || Date.now() - t.at >= account.catchUpMinAgeMs)
          .slice(0, account.catchUpMax);
        api.logger.info(`lagoslife: catch-up replying to ${pending.length} unreplied chats (of ${threads.length} threads)`);
        for (const t of pending) {
          const frame = JSON.stringify({
            t: "msg",
            m: { id: `catchup:${t.id}:${Date.now()}`, kind: "chat", body: t.last!.body, at: t.at ?? Date.now(), from: t.username, fromId: t.id },
          });
          onMessage(frame);
          await sleep(account.catchUpStaggerMs);
        }
        api.logger.info("lagoslife: catch-up dispatch complete");
      } catch (err) {
        api.logger.error(`lagoslife: catch-up failed: ${String(err)}`);
      }
    })();
  }

  api.lifecycle.registerRuntimeLifecycle({
    id: "lagoslife-ws",
    description: "Close the Lagos Life websocket and release runtime state",
    cleanup: () => {
      client.stop();
      activeClient = null;
    },
  });
}

// Enforce the hard cap + cooldown, then transfer.
async function maybeSendMoney(
  client: LagosLifeClient,
  account: Account,
  toId: string,
  toName: string,
  requested: number,
  api: OpenClawPluginApi,
): Promise<void> {
  if (!toId || !Number.isFinite(requested) || requested < 1) return;

  const now = Date.now();
  const last = lastSentAt.get(toId) ?? 0;
  if (account.sendCooldownMs > 0 && now - last < account.sendCooldownMs) {
    api.logger.info(`lagoslife: skipped send to ${toName} (cooldown ${Math.round((account.sendCooldownMs - (now - last)) / 1000)}s left)`);
    return;
  }

  const balance = await client.balance();
  const cap = Math.floor((balance * account.maxSendPct) / 100);
  if (cap < account.minSend) {
    api.logger.info(`lagoslife: skipped send to ${toName} (cap ${fmtNaira(cap)} < min ${fmtNaira(account.minSend)}; balance ${fmtNaira(balance)})`);
    return;
  }
  // clamp to [minSend, cap]
  const amount = Math.min(Math.max(Math.floor(requested), account.minSend), cap);

  const res = await client.sendMoney(toId, amount);
  lastSentAt.set(toId, now);
  const adj = amount !== Math.floor(requested) ? ` (adjusted from ${fmtNaira(Math.floor(requested))} into ${fmtNaira(account.minSend)}–${fmtNaira(cap)})` : "";
  api.logger.info(`lagoslife: sent ${fmtNaira(amount)} to ${toName}${adj}; ok=${res.ok}`);
}

const configAdapter = {
  listAccountIds: () => ["default"],
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveAccount(cfg, accountId),
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
    const a = resolveAccount(cfg, accountId);
    return {
      enabled: a.enabled,
      configured: a.configured,
      tokenStatus: a.configured ? "available" : "missing",
      username: a.username || null,
    };
  },
  isEnabled: (a: Account) => a.enabled,
  isConfigured: (a: Account) => a.configured,
  unconfiguredReason: () => "lagoslife: set channels.lagoslife.username and channels.lagoslife.password",
};

export const lagoslifeChannel = createChatChannelPlugin<Account>({
  base: {
    ...createChannelPluginBase<Account>({
      id: CHANNEL_ID,
      meta: {
        label: "Lagos Life",
        selectionLabel: "Lagos Life",
        docsPath: "",
        blurb: "Listen and reply on the Lagos Life live websocket.",
      },
      config: configAdapter,
      setup: {
        applyAccountConfig: ({ cfg, input }) => ({
          ...cfg,
          channels: {
            ...(cfg as { channels?: Record<string, unknown> }).channels,
            [CHANNEL_ID]: {
              ...((cfg as { channels?: Record<string, Record<string, unknown>> }).channels?.[CHANNEL_ID] ?? {}),
              ...(input as Record<string, unknown>),
            },
          },
        }),
      },
    }),
    config: configAdapter,
    capabilities: { chatTypes: ["direct"] },
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ to, text }: { to: string; text: string }) => {
        if (isMetaLeak(text)) {
          return { messageId: `lagoslife:blocked:${Date.now()}` };
        }
        await activeClient?.dm(stripPrefix(to), humanize(text));
        return { messageId: `lagoslife:${Date.now()}` };
      },
    },
  },
});

const lagoslifeEntry = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Lagos Life",
  description: "Lagos Life live websocket channel (listen, reply, react to money/gifts, send money)",
  plugin: lagoslifeChannel,
  registerFull(api) {
    void startRuntime(api).catch((err) =>
      api.logger.error(`lagoslife: runtime failed to start: ${String(err)}`),
    );
  },
});

export default lagoslifeEntry;
