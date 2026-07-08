// =====================================================================
// EDIT THESE VALUES WITH YOUR REAL CREDENTIALS
// =====================================================================
const CONFIG = {
  geminiKey: "AIzaSyCiKhIZwv8INTzEmOkgMNAqCGUdfc6ID8w",
  ghToken:   "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",
  repo:      "keshavkarn1976-bit/finops",
  filePath:  "data/cur_report_updated.csv",
  model:     "gemini-2.5-flash" 
}; 
// =====================================================================

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

function findPendingRow(rows) {
  return rows.find(r => r["status"] === "pending");
}

// ---------- STEP 2: DECIDE ----------
async function classifyRow(c, row) {
  const description = `${row["lineItem/ProductCode"]} (${row["lineItem/UsageType"]}), resource ${row["lineItem/ResourceId"]}, cost $${row["lineItem/UnblendedCost"]}: ${row["lineItem/LineItemDescription"]}`;

  const prompt = `Classify this AWS cost line item. Respond ONLY as raw JSON, no markdown, no code fences:
{"category": "idle-resource", "savings_potential": "high", "recommended_action": "delete resource"}
Line item: ${description}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${c.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Gemini API Error: ${err.error?.message || res.statusText}`);
  }
  
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text.replace(/```json/g, "").replace(/```/g, "").trim();
  return { description, decision: JSON.parse(text) };
}

// ---------- STEP 3: ACT ----------
async function createIssue(c, description, decision) {
  const url = `https://api.github.com/repos/${c.repo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: getGitHubHeaders(c.ghToken),
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
    headers: getGitHubHeaders(c.ghToken),
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
  if (!CONFIG.geminiKey || CONFIG.ghToken.startsWith("YOUR_")) {
    log("Check your CONFIG credentials in agent.js", "error");
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
        log("No pending items. Agent finished.", "stop");
        break;
      }
      
      log(`PERCEIVE: found ${row["lineItem/ResourceId"]}`, "perceive");
      const { description, decision } = await classifyRow(CONFIG, row);
      log(`DECIDE: Gemini classified item`, "decide");
      const issueUrl = await createIssue(CONFIG, description, decision);
      log(`ACT: opened issue — ${issueUrl}`, "act");
      await updateCurFile(CONFIG, headers, rows, sha, row["lineItem/ResourceId"], decision);
      log(`UPDATE: committed CSV`, "update");
      
      round++;
      await new Promise(r => setTimeout(r, 1500)); 
    }
  } catch (err) {
    log(`CRITICAL ERROR: ${err.message}`, "error");
  } finally {
    setRunning(false);
  }
}
