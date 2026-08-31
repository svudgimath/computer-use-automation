// Vanilla JS, no build step, no framework -- this is a small local verification
// dashboard, not a product. Everything here just calls the API in src/ui/server.ts,
// which itself calls the exact same replayArtifact/runDiscovery the CLI uses.

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// ---------- health ----------

async function refreshHealth() {
  try {
    const h = await fetchJSON("/api/health");
    $("#health").innerHTML =
      `<span><span class="dot ${h.targetAppReachable ? "ok" : "bad"}"></span>target app: ${h.baseUrl}</span>` +
      `<span><span class="dot ${h.hasApiKey ? "ok" : "bad"}"></span>ANTHROPIC_API_KEY: ${h.hasApiKey ? "set" : "missing"}</span>`;
  } catch {
    $("#health").textContent = "could not reach dashboard server";
  }
}

// ---------- capabilities ----------

// Display only -- the actual form field name/param key stays exactly as the artifact declares it
// (e.g. "memberId"); this just renders "Member ID" instead of the raw camelCase for readability.
// "Id" is special-cased to "ID" since that's the far more common convention for that word.
function humanizeParamName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((w) => (w.toUpperCase() === "ID" ? "ID" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function inputFieldHtml(input) {
  const type = input.type === "number" ? "number" : "text";
  // Some recorded artifacts have a description that's just the param name again (the recorder
  // falls back to the name when the model didn't supply a description) -- showing it then would
  // just repeat "memberId memberId". Only show the hint when it actually adds information, and
  // keep the label and hint on one line either way (the label element is flex-column for
  // label-above-input layout, so text nodes as its direct children stack one per line -- wrapping
  // them in a single span keeps them inline instead).
  const hasUsefulHint = input.description && input.description.trim().toLowerCase() !== input.name.trim().toLowerCase();
  const labelLine = `${humanizeParamName(input.name)}${input.required ? " *" : ""}${hasUsefulHint ? ` <span class="hint-inline">— ${input.description}</span>` : ""}`;
  return `
    <label>
      <span class="field-label">${labelLine}</span>
      <input type="${type}" name="${input.name}" ${input.required ? "required" : ""} ${input.sensitive ? 'placeholder="sensitive"' : ""} />
    </label>`;
}

function renderCapabilityCard(artifact) {
  const irreversibleSteps = artifact.steps.filter((s) => s.risk === "irreversible");
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <h3>${artifact.name} <span class="badge ${artifact.risk.hasIrreversibleSteps ? "irreversible" : "safe"}">${artifact.risk.hasIrreversibleSteps ? "irreversible" : "safe"}</span></h3>
    <div class="meta">${artifact.id} · v${artifact.version} · ${artifact.steps.length} steps</div>
    <div class="desc">${artifact.description}</div>
    <div class="io-list">
      <span><strong>inputs:</strong> ${artifact.inputs.map((i) => humanizeParamName(i.name) + (i.sensitive ? " 🔒" : "")).join(", ") || "(none)"}</span>
      <span><strong>outputs:</strong> ${artifact.outputs.map((o) => humanizeParamName(o.name)).join(", ") || "(none)"}</span>
    </div>
    <form class="replay-form">
      ${artifact.inputs.map(inputFieldHtml).join("")}
      ${
        irreversibleSteps.length
          ? `<fieldset><legend>approve irreversible steps</legend>${irreversibleSteps
              .map((s) => `<div class="checkbox-row"><input type="checkbox" name="approve" value="${s.stepId}" id="approve-${artifact.id}-${s.stepId}" /><label for="approve-${artifact.id}-${s.stepId}" style="color:inherit;font-size:12px">${s.stepId}: ${s.description}</label></div>`)
              .join("")}</fieldset>`
          : ""
      }
      <div class="checkbox-row"><input type="checkbox" name="interactive" id="interactive-${artifact.id}" /><label for="interactive-${artifact.id}" style="color:inherit;font-size:12px">Escalate to human on hard failure / approval gate (interactive)</label></div>
      <button type="submit">Run replay</button>
    </form>
  `;

  $(".replay-form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const params = {};
    for (const input of artifact.inputs) {
      const raw = form.elements[input.name].value;
      params[input.name] = input.type === "number" ? Number(raw) : raw;
    }
    const approveSteps = $all('input[name="approve"]:checked', form).map((cb) => cb.value);
    const interactive = form.elements["interactive"].checked;

    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    try {
      const { runId } = await fetchJSON("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilityId: artifact.id, params, approveSteps, interactive }),
      });
      await refreshRunsList();
      selectRun(runId);
    } catch (err) {
      alert(`Replay failed to start: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  return el;
}

async function refreshCapabilities() {
  const list = await fetchJSON("/api/capabilities");
  const container = $("#capabilities");
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = `<p class="hint">No artifacts in /artifacts yet -- record one below.</p>`;
    return;
  }
  for (const artifact of list) container.appendChild(renderCapabilityCard(artifact));
}

// ---------- discovery ----------

$("#discover-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const goal = form.elements.goal.value.trim();
  const capabilityId = form.elements.capabilityId.value.trim();
  const name = form.elements.name.value.trim();
  const description = form.elements.description.value.trim();

  const submitBtn = $('button[type="submit"]', form);
  submitBtn.disabled = true;
  try {
    const { runId } = await fetchJSON("/api/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, capabilityId, name, description }),
    });
    await refreshRunsList();
    selectRun(runId);
  } catch (err) {
    alert(`Discovery failed to start: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- runs list + detail ----------

let selectedRunId = null;
let runsPollHandle = null;
let detailPollHandle = null;

function statusOf(record) {
  if (record.status === "running") return "running";
  const s = record.result?.status;
  return s || record.status;
}

async function refreshRunsList() {
  const runs = await fetchJSON("/api/runs");
  const el = $("#runs-list");
  el.innerHTML = "";
  for (const r of runs) {
    const li = document.createElement("li");
    li.className = r.runId === selectedRunId ? "selected" : "";
    li.innerHTML = `<span class="badge ${r.status}">${r.status}</span> ${r.kind} · ${r.capabilityId}<span class="run-id">${r.runId}</span>`;
    li.addEventListener("click", () => selectRun(r.runId));
    el.appendChild(li);
  }
  const anyRunning = runs.some((r) => r.status === "running");
  return anyRunning;
}

function selectRun(runId) {
  selectedRunId = runId;
  $all("#runs-list li").forEach((li) => li.classList.toggle("selected", li.textContent.includes(runId)));
  if (detailPollHandle) clearInterval(detailPollHandle);
  renderRunDetail(runId);
  detailPollHandle = setInterval(async () => {
    const done = await renderRunDetail(runId);
    if (done) clearInterval(detailPollHandle);
  }, 1000);
}

function fmtLogEntry(e) {
  const known = new Set(["seq", "ts", "stepId", "action", "description"]);
  const extra = Object.fromEntries(Object.entries(e).filter(([k]) => !known.has(k)));
  const hasExtra = Object.keys(extra).length > 0;
  return `
    <div class="log-entry">
      <div class="head"><span>#${e.seq}</span><span>${(e.ts || "").split("T")[1]?.replace("Z", "") || ""}</span><span class="action">${e.action || ""}</span>${e.stepId ? `<span>${e.stepId}</span>` : ""}</div>
      ${e.description ? `<div class="body">${e.description}</div>` : ""}
      ${e.modelReasoning ? `<div class="body">${typeof e.modelReasoning === "string" ? e.modelReasoning : JSON.stringify(e.modelReasoning)}</div>` : ""}
      ${hasExtra ? `<pre>${escapeHtml(JSON.stringify(extra, null, 2))}</pre>` : ""}
    </div>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

async function renderRunDetail(runId) {
  let detail;
  try {
    detail = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}`);
  } catch (err) {
    $("#run-detail").innerHTML = `<p class="hint">${err.message}</p>`;
    return true;
  }

  const el = $("#run-detail");
  const isDone = detail.status !== "running";

  let interventionHtml = "";
  if (detail.controlState && detail.controlState.owner === "human" && detail.controlState.intervention) {
    const iv = detail.controlState.intervention;
    interventionHtml = `
      <div class="intervention">
        <div class="title">Human intervention requested</div>
        <div><strong>Reason:</strong> ${iv.reason}</div>
        <div><strong>Context:</strong> ${iv.stepContext}</div>
        <div><strong>Page:</strong> ${iv.currentUrl}</div>
        <button class="small" id="resume-btn">Resume automation</button>
      </div>`;
  }

  const resultHtml =
    detail.status === "error"
      ? `<div class="result-json"><strong>Error:</strong> ${escapeHtml(detail.errorMessage || "unknown error")}</div>`
      : detail.result
        ? `<pre class="result-json">${escapeHtml(JSON.stringify(detail.result, null, 2))}</pre>`
        : "";

  el.innerHTML = `
    <h3><span class="badge ${statusOf(detail)}">${statusOf(detail)}</span> ${detail.kind} · ${detail.capabilityId}</h3>
    <div class="hint">${runId}</div>
    ${interventionHtml}
    ${resultHtml}
    ${detail.screenshots.length ? `<div class="screenshots">${detail.screenshots.map((f) => `<img src="/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(f)}" data-full="/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(f)}" title="${f}" />`).join("")}</div>` : ""}
    <div class="log">${detail.log.map(fmtLogEntry).join("")}</div>
  `;

  const resumeBtn = $("#resume-btn", el);
  if (resumeBtn) {
    resumeBtn.addEventListener("click", async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resuming…";
      try {
        await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
      } catch (err) {
        alert(err.message);
        resumeBtn.disabled = false;
      }
    });
  }

  $all(".screenshots img", el).forEach((img) => {
    img.addEventListener("click", () => {
      $("#lightbox-img").src = img.dataset.full;
      $("#lightbox").classList.remove("hidden");
    });
  });

  return isDone;
}

$("#lightbox").addEventListener("click", () => $("#lightbox").classList.add("hidden"));

// ---------- boot ----------

async function boot() {
  await refreshHealth();
  await refreshCapabilities();
  await refreshRunsList();
  setInterval(refreshHealth, 5000);
  runsPollHandle = setInterval(refreshRunsList, 3000);
}

boot();
