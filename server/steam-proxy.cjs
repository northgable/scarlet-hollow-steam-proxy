require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const APPID = 1609230;

const IS_PROD = process.env.NODE_ENV === "production";

console.log(
  "🔑 STEAM_API_KEY loaded?",
  !!STEAM_API_KEY,
  "length:",
  (STEAM_API_KEY || "").length
);
console.log("🛡️ Turnstile enforced?", IS_PROD ? "YES (production)" : "NO (dev)");

if (!STEAM_API_KEY) {
  console.error("❌ Missing STEAM_API_KEY in .env");
  process.exit(1);
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

function cleanProfileUrl(u) {
  return String(u || "").trim();
}

function isSteamID64(s) {
  return /^[0-9]{17}$/.test(String(s));
}

function redactKey(url) {
  return STEAM_API_KEY ? url.replace(STEAM_API_KEY, "REDACTED") : url;
}

async function verifyTurnstileOrSkip(token, remoteip) {
  if (!IS_PROD) return { success: true, skipped: true };
  if (!TURNSTILE_SECRET_KEY) throw new Error("Missing TURNSTILE_SECRET_KEY in production");
  if (!token) return { success: false, error: "Missing turnstileToken" };

  const form = new URLSearchParams();
  form.append("secret", TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (remoteip) form.append("remoteip", remoteip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = await resp.json().catch(() => null);
  if (!data?.success) return { success: false, error: "Turnstile failed", details: data };
  return { success: true };
}

async function resolveVanity(vanity) {
  const url =
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/` +
    `?key=${encodeURIComponent(STEAM_API_KEY)}` +
    `&vanityurl=${encodeURIComponent(vanity)}`;

  console.log("➡️ Resolving vanity:", vanity);
  console.log("➡️ Fetching:", redactKey(url));

  const res = await fetch(url);
  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch {}

  if (!res.ok) {
    console.log("⬅️ ResolveVanityURL status:", res.status, res.statusText);
    console.log("⬅️ ResolveVanityURL body:", rawText.slice(0, 1200));
    throw new Error(`ResolveVanityURL failed (HTTP ${res.status})`);
  }

  const steamid = data?.response?.steamid;
  const success = data?.response?.success;
  if (success !== 1 || !steamid) throw new Error(`Could not resolve that Steam profile. (vanity=${vanity})`);
  return steamid;
}

async function resolveSteamId64(profile) {
  const p = cleanProfileUrl(profile);

  if (isSteamID64(p)) return p;

  const mProfiles = p.match(/steamcommunity\.com\/profiles\/([0-9]{17})/i);
  if (mProfiles) return mProfiles[1];

  const mVanity = p.match(/steamcommunity\.com\/id\/([^\/\?\#]+)/i);
  if (mVanity) return await resolveVanity(mVanity[1]);

  return await resolveVanity(p);
}

async function getPlayerAchievements(steamid64) {
  const url =
    `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/` +
    `?key=${encodeURIComponent(STEAM_API_KEY)}` +
    `&steamid=${encodeURIComponent(steamid64)}` +
    `&appid=${encodeURIComponent(String(APPID))}`;

  console.log("➡️ Fetching:", redactKey(url));

  const res = await fetch(url);
  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch {}

  console.log("⬅️ GetPlayerAchievements status:", res.status, res.statusText);

  if (!res.ok) {
    console.log("⬅️ GetPlayerAchievements body:", rawText.slice(0, 1200));
    throw new Error(`Steam API error (HTTP ${res.status})`);
  }

  const ps = data?.playerstats;
  if (!ps) throw new Error("Unexpected Steam response (missing playerstats).");
  if (ps.error) throw new Error(ps.error);

  const achievements = Array.isArray(ps.achievements) ? ps.achievements : [];
  return achievements;
}

async function handleSync(profile, client) {
  const steamid64 = await resolveSteamId64(profile);
  const list = await getPlayerAchievements(steamid64);

  console.log("📦 client entries received:", Array.isArray(client) ? client.length : "not array");

  const apiToKey = new Map();
  for (const a of client || []) {
    if (a?.apiname && a?.key) apiToKey.set(a.apiname, a.key);
  }

  const unlocked = [];
  for (const a of list) {
    if (Number(a?.achieved) !== 1) continue;
    const key = apiToKey.get(a.apiname);
    if (key) unlocked.push(key);
  }

  return { steamid64, unlocked, count: unlocked.length };
}

app.post("/api/steam-sync", async (req, res) => {
  try {
    const profile = String(req.body?.profile || "").trim();
    if (!profile) return res.status(400).json({ error: "Missing profile" });

    const client = Array.isArray(req.body?.client) ? req.body.client : [];
    const turnstileToken = String(req.body?.turnstileToken || "").trim();

    const ts = await verifyTurnstileOrSkip(turnstileToken, req.ip);
    if (!ts.success) return res.status(400).json({ error: ts.error, details: ts.details });

    const out = await handleSync(profile, client);
    res.json(out);
  } catch (e) {
    console.error("❌ POST /api/steam-sync error:", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});

app.get("/api/steam-sync", async (req, res) => {
  res.status(400).json({ error: "Missing profile" });
});

app.listen(PORT, () => {
  console.log(`✅ Steam sync server running on http://localhost:${PORT}`);
});