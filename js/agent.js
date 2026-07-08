// =====================================================================
// EDIT THESE 4 VALUES WITH YOUR REAL CREDENTIALS BEFORE RUNNING
// =====================================================================
const CONFIG = {
  geminiKey: "AIzaSyCiKhIZwv8INTzEmOkgMNAqCGUdfc6ID8w",
  ghToken:   "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",
  repo:      "keshavkarn1976-bit/finops",
  filePath:  "data/cur_report_updated.csv"
}; 
// =====================================================================

// show masked config on the page so you can visually confirm it's set
function maskKey(k) {
  if (!k || k.startsWith("PASTE_")) return "NOT SET";
  return k.slice(0, 4) + "..." + k.slice(-4);
}
document.getElementById("cfgGemini").textContent = maskKey(CONFIG.geminiKey);
document.getElementById("cfgToken").textContent = maskKey(CONFIG.ghToken);
document.getElementById("cfgRepo").textContent = CONFIG.repo || "NOT SET";
document.getElementById("cfgPath").textContent = CONFIG.filePath || "NOT SET";

// ---------- logging ----------
function log(msg, tag) {
  const el = document.getElementById("log");
  const line = document.createElement("div");
  line.className = "line" + (tag ? " tag-" + tag : "");
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { document.getElementById("log").innerHTML = ""; }
function setRunning(isRunning) {
  document.getElementById("runBtn").disabled = isRunning;
  document.getElementById("statusDot").className = "status-dot" + (isRunning ? " running" : "");
  document.getElementById("statusText").textContent = isRunning ? "Agent running..." : "Idle";
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

// ---------- base64 helpers (UTF-8 safe) ----------
function b64Encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64Decode(str) { return decodeURIComponent(escape(atob(str))); }

// ---------- STEP 1: PERCEIVE ----------
async function fetchCurFile(c) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.filePath}`;
  const res = await fetch(url, { headers: { "Authorization": `token ${c.ghToken}` } });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} (check repo name and file path)`);
  const data = await res.json();
  const content = b64Decode(data.content);
  const { headers, rows } = parseCSV(content);
  return { headers, rows, sha: data.sha };
}
function findPendingRow(rows) {
  return rows.find(r => r["status"] === "pending");
}

// ---------- STEP 2: DECIDE ----------
async function classifyRow(c, row) {
  const description = `${row["lineItem/ProductCode"]} (${row["lineItem/UsageType"]}), resource ${row["lineItem/ResourceId"]}, cost $${row["lineItem/UnblendedCost"]}: ${row["lineItem/LineItemDescription"]}`;

  const prompt = `Classify this AWS cost line item. Respond ONLY as raw JSON, no markdown, no code fences:
{"category": "idle-resource|oversized|orphaned|misconfigured", "savings_potential": "low|medium|high", "recommended_action": "one sentence"}

Line item: ${description}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${c.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) throw new Error(`Gemini call failed: ${res.status}`);
  const data = await res.json();
  let text = data.candidates[0].content.parts[0].text.trim();
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return { description, decision: JSON.parse(text) };
}

// ---------- STEP 3: ACT ----------
async function createIssue(c, description, decision) {
  const url = `https://api.github.com/repos/${c.repo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `token ${c.ghToken}`,
      "Accept": "application/vnd.github+json"
    },
    body: JSON.stringify({
      title: description.slice(0, 70),
      body: `${description}\n\n**Recommended action:** ${decision.recommended_action}`,
      labels: [decision.category, `savings-${decision.savings_potential}`]
    })
  });
  if (!res.ok) throw new Error(`Issue creation failed: ${res.status}`);
  const data = await res.json();
  return data.html_url;
}

// ---------- STEP 4: UPDATE ----------
async function updateCurFile(c, headers, rows, sha, resourceId, decision) {
  rows.forEach(r => {
    if (r["lineItem/ResourceId"] === resourceId) {
      r["status"] = "done";
      r["decision"] = JSON.stringify(decision).replace(/,/g, ";");
    }
  });
  const newContent = toCSV(headers, rows);
  const url = `https://api.github.com/repos/${c.repo}/contents/${c.filePath}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `token ${c.ghToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Agent: triaged ${resourceId}`,
      content: b64Encode(newContent),
      sha: sha
    })
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status}`);
}

// ---------- THE AGENT LOOP ----------
async function runAgent() {
  if (!CONFIG.geminiKey || CONFIG.geminiKey.startsWith("PASTE_") ||
      !CONFIG.ghToken || CONFIG.ghToken.startsWith("PASTE_") ||
      !CONFIG.repo || !CONFIG.filePath) {
    log("CONFIG is not filled in. Edit the CONFIG object at the top of agent.js with your real Gemini key, GitHub token, repo, and file path.", "error");
    return;
  }

  setRunning(true);
  log("Agent starting...", "stop");

  try {
    let round = 1;
    while (true) {
      log(`--- Round ${round} ---`, "stop");

      const { headers, rows, sha } = await fetchCurFile(CONFIG);
      const row = findPendingRow(rows);
      if (!row) {
        log("No pending line items found. Agent deciding it's done. Stopping.", "stop");
        break;
      }
      log(`PERCEIVE: found ${row["lineItem/ResourceId"]}`, "perceive");

      const { description, decision } = await classifyRow(CONFIG, row);
      log(`DECIDE: Gemini classified as ${JSON.stringify(decision)}`, "decide");

      const issueUrl = await createIssue(CONFIG, description, decision);
      log(`ACT: opened GitHub issue — ${issueUrl}`, "act");

      await updateCurFile(CONFIG, headers, rows, sha, row["lineItem/ResourceId"], decision);
      log(`UPDATE: committed ${CONFIG.filePath} — row marked done`, "update");

      round++;
      await new Promise(r => setTimeout(r, 1200)); // be polite to rate limits
    }
    log("Agent finished.", "stop");
  } catch (err) {
    log(`ERROR: ${err.message}`, "error");
  } finally {
    setRunning(false);
  }
}
