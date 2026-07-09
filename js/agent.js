// =====================================================================
// CONFIG — credentials are NOT collected here. They're prompted lazily
// from the Run button click (a real user gesture), then cached in
// sessionStorage — never hardcoded, never committed.
// =====================================================================
const CONFIG = {
  repo:        "keshavkarn1976-bit/finops",
  filePath:    "data/cur_report_updated.csv",
  ticketsPath: "data/tickets.json",
  model:       "gemini-2.5-flash",
  batchSize:   15
};

// Some browser contexts (e.g. embedded/automated ones) disallow window.prompt
// entirely and throw instead of returning null — never let that crash the run.
function getCredential(storageKey, label) {
  const cached = sessionStorage.getItem(storageKey);
  if (cached) return cached;
  let value = null;
  try { value = prompt(`Enter your ${label}`); } catch { value = null; }
  if (value) sessionStorage.setItem(storageKey, value);
  return value;
}

/**
 * Standard GitHub API headers to prevent 401 errors.
 */
function getGitHubHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };
}

// ---------- fixed taxonomy -> resolver group ----------
const CATEGORY_TEAM_MAP = {
  "idle-resource":  "FinOps — Idle Resources Team",
  "oversized":      "Platform Engineering Team",
  "orphaned":        "Cloud Cleanup Team",
  "misconfigured":   "Security & Compliance Team"
};
const FALLBACK_TEAM = "General Ops Team";
const VALID_CATEGORIES = Object.keys(CATEGORY_TEAM_MAP);

function resolveTeam(category) {
  return CATEGORY_TEAM_MAP[category] || FALLBACK_TEAM;
}

// ---------- logging ----------
function log(msg, tag) {
  const el = document.getElementById("log");
  if (!el) return;
  const line = document.createElement("div");
  line.className = "line" + (tag ? " tag-" + tag : "");
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearLog() { document.getElementById("log").innerHTML = ""; }

function setRunning(isRunning) {
  const runBtn = document.getElementById("runBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  if (runBtn) runBtn.disabled = isRunning;
  if (statusDot) statusDot.className = "status-dot" + (isRunning ? " running" : "");
  if (statusText) statusText.textContent = isRunning ? "Agent running..." : "Idle";
}

// ---------- CSV helpers ----------
function splitCSVLine(line) {
  const result = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(cur); cur = ""; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = splitCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = values[idx] ?? "");
    rows.push(row);
  }
  return { headers, rows };
}

function toCSV(headers, rows) {
  const escape = v => (v && String(v).includes(",")) ? `"${v}"` : (v ?? "");
  const lines = [headers.join(",")];
  rows.forEach(r => lines.push(headers.map(h => escape(r[h])).join(",")));
  return lines.join("\n");
}

// ---------- base64 helpers ----------
function b64Encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64Decode(str) { return decodeURIComponent(escape(atob(str))); }

// ---------- misc helpers ----------
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function buildLineItemDescription(row) {
  return `${row["lineItem/ProductCode"]} (${row["lineItem/UsageType"]}), resource ${row["lineItem/ResourceId"]}, cost $${row["lineItem/UnblendedCost"]}: ${row["lineItem/LineItemDescription"]}`;
}

// ---------- STEP 1: PERCEIVE ----------
async function fetchCurFile(c) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.filePath}`;
  const res = await fetch(url, { headers: getGitHubHeaders(c.ghToken) });

  if (!res.ok) {
    const errorDetails = await res.json().catch(() => ({}));
    throw new Error(`GitHub read failed: ${res.status} (${errorDetails.message || 'Unauthorized'})`);
  }

  const data = await res.json();
  const content = b64Decode(data.content);
  const { headers, rows } = parseCSV(content);
  return { headers, rows, sha: data.sha };
}

function findPendingRows(rows) {
  return rows.filter(r => r["status"] === "pending");
}

async function fetchTicketsFile(c) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.ticketsPath}`;
  const res = await fetch(url, { headers: getGitHubHeaders(c.ghToken) });

  if (res.status === 404) return { tickets: [], sha: null };
  if (!res.ok) {
    const errorDetails = await res.json().catch(() => ({}));
    throw new Error(`GitHub read failed (tickets): ${res.status} (${errorDetails.message || 'Unauthorized'})`);
  }

  const data = await res.json();
  const content = b64Decode(data.content).trim();
  const tickets = content ? JSON.parse(content) : [];
  return { tickets, sha: data.sha };
}

// ---------- STEP 2: DECIDE (batch) ----------
async function classifyBatch(c, rows) {
  const items = rows.map(r => ({
    resourceId: r["lineItem/ResourceId"],
    description: buildLineItemDescription(r)
  }));

  const prompt = `Classify each AWS cost line item below into exactly one category from this fixed list: ${VALID_CATEGORIES.join(", ")}.
Respond ONLY as a raw JSON array, no markdown, no code fences. One object per line item, in this exact shape:
{"resourceId": "...", "category": "idle-resource", "savings_potential": "high", "recommended_action": "delete resource"}

Line items:
${items.map(i => `- ${i.resourceId}: ${i.description}`).join("\n")}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${c.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini API Error: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text.replace(/```json/g, "").replace(/```/g, "").trim();

  let parsed = [];
  try { parsed = JSON.parse(text); } catch { parsed = []; }
  const byResourceId = new Map(parsed.map(p => [p.resourceId, p]));

  return items.map(item => {
    const result = byResourceId.get(item.resourceId);
    const category = result && VALID_CATEGORIES.includes(result.category) ? result.category : null;
    return {
      resourceId: item.resourceId,
      description: item.description,
      category: category || "uncategorized",
      savingsPotential: category ? (result.savings_potential || "unknown") : "unknown",
      recommendedAction: category ? (result.recommended_action || "manual review needed") : "manual review needed"
    };
  });
}

// ---------- STEP 3: ACT ----------
let ticketCounter = 0;
function buildTicket(classification, row) {
  ticketCounter++;
  return {
    id: `${classification.resourceId}-${Date.now()}-${ticketCounter}`,
    resourceId: classification.resourceId,
    description: classification.description,
    category: classification.category,
    resolverGroup: resolveTeam(classification.category),
    savingsPotential: classification.savingsPotential,
    recommendedAction: classification.recommendedAction,
    cost: row["lineItem/UnblendedCost"],
    createdAt: new Date().toISOString()
  };
}

async function writeTicketsFile(c, tickets, sha, batchNum) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.ticketsPath}`;
  const body = {
    message: `Agent: filed ticket batch ${batchNum}`,
    content: b64Encode(JSON.stringify(tickets, null, 2))
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, { method: "PUT", headers: getGitHubHeaders(c.ghToken), body: JSON.stringify(body) });
  if (!res.ok) {
    const errorDetails = await res.json().catch(() => ({}));
    throw new Error(`GitHub write failed (tickets): ${res.status} (${errorDetails.message || 'unknown'})`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ---------- STEP 4: UPDATE ----------
function applyDecisions(rows, classifications) {
  const byResourceId = new Map(classifications.map(c => [c.resourceId, c]));
  rows.forEach(row => {
    const c = byResourceId.get(row["lineItem/ResourceId"]);
    if (!c) return;
    row["status"] = "done";
    row["decision"] = JSON.stringify({
      category: c.category,
      savingsPotential: c.savingsPotential,
      recommendedAction: c.recommendedAction
    }).replace(/,/g, ";");
  });
}

async function commitCurFile(c, headers, rows, sha, message) {
  const newContent = toCSV(headers, rows);
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.filePath}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: getGitHubHeaders(c.ghToken),
    body: JSON.stringify({ message, content: b64Encode(newContent), sha })
  });

  if (!res.ok) {
    const errorDetails = await res.json().catch(() => ({}));
    throw new Error(`GitHub write failed: ${res.status} (${errorDetails.message || 'unknown'})`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ---------- THE AGENT LOOP ----------
let isRunning = false;

async function runAgent() {
  if (isRunning) return;
  isRunning = true;
  setRunning(true);

  CONFIG.geminiKey = getCredential("geminiKey", "Gemini API Key");
  CONFIG.ghToken = getCredential("ghToken", "GitHub Token");

  if (!CONFIG.geminiKey || !CONFIG.ghToken) {
    log("Missing Gemini key or GitHub token — click Run Agent again to re-enter them.", "error");
    isRunning = false;
    setRunning(false);
    return;
  }

  log("Agent starting...", "stop");

  try {
    log("PERCEIVE: reading CSV...", "perceive");
    const { headers, rows, sha: initialSha } = await fetchCurFile(CONFIG);
    let curFileSha = initialSha;
    const pending = findPendingRows(rows);

    if (pending.length === 0) {
      log("No pending items. Agent finished.", "stop");
      return;
    }
    log(`PERCEIVE: found ${pending.length} pending row(s).`, "perceive");

    log("PERCEIVE: reading ticket store...", "perceive");
    let { tickets, sha: ticketsSha } = await fetchTicketsFile(CONFIG);

    const batches = chunkArray(pending, CONFIG.batchSize);
    let ticketsCreated = 0;
    const teamsTouched = new Set();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      log(`--- Batch ${i + 1}/${batches.length} (${batch.length} row(s)) ---`, "stop");

      const classifications = await classifyBatch(CONFIG, batch);
      log(`DECIDE: Gemini classified ${classifications.length} item(s).`, "decide");

      const newTickets = classifications.map(cl => {
        const row = batch.find(r => r["lineItem/ResourceId"] === cl.resourceId);
        return buildTicket(cl, row);
      });
      newTickets.forEach(t => teamsTouched.add(t.resolverGroup));
      tickets = tickets.concat(newTickets);
      ticketsSha = await writeTicketsFile(CONFIG, tickets, ticketsSha, i + 1);
      ticketsCreated += newTickets.length;
      log(`ACT: filed ${newTickets.length} ticket(s) to tickets.json`, "act");

      applyDecisions(rows, classifications);
      curFileSha = await commitCurFile(CONFIG, headers, rows, curFileSha, `Agent: triaged batch ${i + 1}`);
      log(`UPDATE: committed CSV batch ${i + 1}`, "update");

      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    log(`Agent finished. ${ticketsCreated} ticket(s) filed across ${teamsTouched.size} team(s).`, "stop");
  } catch (err) {
    log(`CRITICAL ERROR: ${err.message}`, "error");
  } finally {
    isRunning = false;
    setRunning(false);
  }
}
