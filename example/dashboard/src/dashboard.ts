/**
 * The dashboard page, kept out of index.ts so the routing stays readable.
 *
 * A single self-contained HTML document — inline CSS, vanilla JS, no external
 * resources. It is part of the demo's teaching surface, so the code is plain on
 * purpose: it polls ONE endpoint (`/poll`) every 1.5s and renders four panels
 * from the blob, and it posts the forms and buttons to the proxy routes.
 *
 * The page's own JavaScript is written with string concatenation rather than
 * template literals, so this file can hold it in a normal template literal
 * without a single escaped `${`.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>durable-rate-limiter — shared quota dashboard</title>
<style>
  :root {
    --bg: #0f1420;
    --panel: #171d2b;
    --panel-2: #1e2536;
    --line: #2b3450;
    --ink: #e6ebf5;
    --dim: #8b96ad;
    --alpha: #2dd4bf;
    --bravo: #a78bfa;
    --warn: #f2b544;
    --ok: #3ecf8e;
    --bad: #ef5f6b;
    --accent: #5b9dff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  header {
    padding: 18px 22px;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
  }
  h1 { margin: 0; font-size: 17px; font-weight: 600; }
  header p { margin: 4px 0 0; color: var(--dim); max-width: 74ch; }
  .poll-flag { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 7px; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: pulse 1.5s ease-in-out infinite; }
  .poll-flag.bad .pulse { background: var(--bad); animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
  main { padding: 18px 22px; display: grid; gap: 18px; }
  .row { display: grid; gap: 18px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px;
  }
  .panel h2 {
    margin: 0 0 14px;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.alpha { background: var(--alpha); }
  .dot.bravo { background: var(--bravo); }
  .tiles { display: grid; gap: 10px; grid-template-columns: repeat(3, 1fr); }
  .tiles.five { grid-template-columns: repeat(5, 1fr); }
  @media (max-width: 520px) { .tiles, .tiles.five { grid-template-columns: repeat(2, 1fr); } }
  .tile {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .tile .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 20px; font-variant-numeric: tabular-nums; margin-top: 3px; }
  .tile.warn .value { color: var(--warn); }
  .tile.ok .value { color: var(--ok); }
  .tile.bad .value { color: var(--bad); }
  .badge {
    display: inline-flex; align-items: center; gap: 7px;
    border-radius: 999px; padding: 5px 12px; font-size: 12px;
    border: 1px solid var(--line); margin: 14px 0 0;
  }
  .badge.good { color: var(--ok); border-color: rgba(62,207,142,0.4); background: rgba(62,207,142,0.08); }
  .badge.bad { color: var(--bad); border-color: rgba(239,95,107,0.4); background: rgba(239,95,107,0.08); }
  form { display: grid; gap: 10px; margin-top: 14px; }
  .field { display: grid; grid-template-columns: 1fr 120px; align-items: center; gap: 8px; }
  label { color: var(--dim); }
  input {
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--ink);
    border-radius: 6px;
    padding: 6px 8px;
    font: inherit;
    width: 100%;
  }
  button {
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--ink);
    border-radius: 6px;
    padding: 7px 12px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: var(--dim); }
  button.primary { background: #24406e; border-color: #35548a; }
  button.alpha { border-color: var(--alpha); color: var(--alpha); }
  button.bravo { border-color: var(--bravo); color: var(--bravo); }
  button.danger { border-color: var(--bad); color: var(--bad); }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
  .card-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .card-controls input { width: 70px; }
  .feedback { min-height: 18px; color: var(--dim); font-size: 12px; }
  .error { color: var(--bad); font-size: 12px; min-height: 16px; }
  .hint { color: var(--dim); font-size: 12px; margin: 10px 0 0; }
</style>
</head>
<body>
<header>
  <div>
    <h1>durable-rate-limiter — one bucket, two apps, one mock upstream</h1>
    <p>app-alpha and app-bravo deploy independently and share nothing but the
       bucket name, so both pace against one allowance. The upstream is a mock
       third party enforcing its own rolling limit; the limiter is configured
       under it, so the demo starts clean. Raise the limiter's limit past the
       mock's to provoke real 429s and watch the shared penalty pause both apps.</p>
  </div>
  <div id="poll-flag" class="poll-flag"><span class="pulse"></span><span id="poll-text">polling every 1.5s</span></div>
</header>
<main>
  <div class="row">
    <!-- Mock third-party API -->
    <div class="panel">
      <h2>Mock third-party API</h2>
      <div class="tiles">
        <div class="tile"><div class="label">remaining</div><div class="value" id="up-remaining">–</div></div>
        <div class="tile"><div class="label">window resets</div><div class="value" id="up-reset">–</div></div>
        <div class="tile"><div class="label">served / 429</div><div class="value" id="up-counts">–</div></div>
      </div>
      <form id="up-form">
        <div class="field"><label for="up-limit">limit / window</label><input id="up-limit" type="number" min="1" /></div>
        <div class="field"><label for="up-window">window (s)</label><input id="up-window" type="number" min="1" /></div>
        <div class="field"><label for="up-work">work (ms)</label><input id="up-work" type="number" min="0" /></div>
        <div class="actions">
          <button class="primary" type="submit">Apply</button>
          <button class="danger" type="button" id="up-reset-btn">Reset window &amp; counters</button>
        </div>
      </form>
      <div id="up-error" class="error"></div>
    </div>

    <!-- Limiter (durable object) -->
    <div class="panel">
      <h2>Limiter (durable object)</h2>
      <div class="tiles">
        <div class="tile"><div class="label">remaining</div><div class="value" id="lim-remaining">–</div></div>
        <div class="tile"><div class="label">window resets</div><div class="value" id="lim-reset">–</div></div>
        <div class="tile"><div class="label">in flight / conc</div><div class="value" id="lim-active">–</div></div>
      </div>
      <div id="lim-penalty" class="badge good"><span>no penalty</span></div>
      <form id="lim-form">
        <div class="field"><label for="lim-limit">limitPerWindow</label><input id="lim-limit" type="number" min="1" /></div>
        <div class="field"><label for="lim-window">windowInMs</label><input id="lim-window" type="number" min="1" /></div>
        <div class="field"><label for="lim-conc">concurrency</label><input id="lim-conc" type="number" min="1" /></div>
        <div class="actions"><button class="primary" type="submit">Apply</button></div>
      </form>
      <p class="hint">configure is complete, never a patch — Apply rebuilds the
         bucket and rejects anyone queued. Retry settings are carried over.</p>
      <div id="lim-error" class="error"></div>
    </div>
  </div>

  <!-- Per-app request states -->
  <div class="row">
    <div class="panel">
      <h2><span class="dot alpha"></span> app-alpha</h2>
      <div class="card-controls">
        <label for="n-alpha">burst</label>
        <input id="n-alpha" type="number" min="1" max="20" value="8" />
        <button class="alpha" id="burst-alpha">Burst</button>
        <button class="danger" id="reset-alpha">Reset</button>
      </div>
      <div class="tiles five">
        <div class="tile"><div class="label">queued</div><div class="value" id="alpha-queued">0</div></div>
        <div class="tile"><div class="label">in flight</div><div class="value" id="alpha-inFlight">0</div></div>
        <div class="tile warn"><div class="label">requeued</div><div class="value" id="alpha-requeued">0</div></div>
        <div class="tile ok"><div class="label">completed</div><div class="value" id="alpha-completed">0</div></div>
        <div class="tile bad"><div class="label">dropped</div><div class="value" id="alpha-dropped">0</div></div>
      </div>
      <div id="alpha-error" class="error"></div>
      <div id="alpha-fb" class="feedback"></div>
    </div>

    <div class="panel">
      <h2><span class="dot bravo"></span> app-bravo</h2>
      <div class="card-controls">
        <label for="n-bravo">burst</label>
        <input id="n-bravo" type="number" min="1" max="20" value="8" />
        <button class="bravo" id="burst-bravo">Burst</button>
        <button class="danger" id="reset-bravo">Reset</button>
      </div>
      <div class="tiles five">
        <div class="tile"><div class="label">queued</div><div class="value" id="bravo-queued">0</div></div>
        <div class="tile"><div class="label">in flight</div><div class="value" id="bravo-inFlight">0</div></div>
        <div class="tile warn"><div class="label">requeued</div><div class="value" id="bravo-requeued">0</div></div>
        <div class="tile ok"><div class="label">completed</div><div class="value" id="bravo-completed">0</div></div>
        <div class="tile bad"><div class="label">dropped</div><div class="value" id="bravo-dropped">0</div></div>
      </div>
      <div id="bravo-error" class="error"></div>
      <div id="bravo-fb" class="feedback"></div>
    </div>
  </div>
</main>

<script>
"use strict";
(function () {
  var POLL_MS = 1500;

  // Countdown targets (epoch ms) refreshed by each poll; a ticker turns them
  // into a smooth "resets in" text between polls.
  var st = {
    limReset: null, limForced: 0, limPenalised: false, upReset: null
  };

  function $(id) { return document.getElementById(id); }
  function text(id, value) { $(id).textContent = value; }
  function fmtMs(ms) {
    if (ms <= 0) return "0s";
    var s = Math.ceil(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
  function isError(section) {
    return section !== null && typeof section === "object" && "error" in section;
  }
  function focused(id) { return document.activeElement === $(id); }

  function renderUpstream(u) {
    if (isError(u)) { text("up-error", u.error); return; }
    text("up-error", "");
    text("up-remaining", String(u.remaining) + " / " + String(u.limitPerWindow));
    text("up-counts", String(u.served) + " / " + String(u.rejected));
    st.upReset = u.resetInMs > 0 ? Date.now() + u.resetInMs : Date.now();
    if (!focused("up-limit")) $("up-limit").value = String(u.limitPerWindow);
    if (!focused("up-window")) $("up-window").value = String(Math.round(u.windowMs / 1000));
    if (!focused("up-work")) $("up-work").value = String(u.processingMs);
  }

  function renderLimiter(l) {
    if (isError(l)) { text("lim-error", l.error); return; }
    text("lim-error", "");
    text("lim-remaining", String(l.remaining) + " / " + String(l.config.bucket.limitPerWindow));
    text("lim-active", String(l.active) + " / " + String(l.config.concurrency));
    st.limReset = l.resetAt;
    st.limForced = l.forcedUntil;
    st.limPenalised = l.penalised;
    if (!focused("lim-limit")) $("lim-limit").value = String(l.config.bucket.limitPerWindow);
    if (!focused("lim-window")) $("lim-window").value = String(l.config.bucket.windowInMs);
    if (!focused("lim-conc")) $("lim-conc").value = String(l.config.concurrency);
  }

  function renderApp(prefix, s) {
    if (isError(s)) { text(prefix + "-error", s.error); return; }
    text(prefix + "-error", "");
    var keys = ["queued", "inFlight", "requeued", "completed", "dropped"];
    for (var i = 0; i < keys.length; i++) {
      text(prefix + "-" + keys[i], String(s.counts[keys[i]]));
    }
    var b = s.droppedBreakdown;
    $(prefix + "-dropped").title =
      "queue " + b.droppedQueue + " · 429 " + b.exhausted429 + " · failed " + b.failed;
  }

  function updateCountdowns() {
    var now = Date.now();
    text("lim-reset", st.limReset === null ? "–" : (st.limReset <= now ? "whole" : fmtMs(st.limReset - now)));
    text("up-reset", st.upReset === null ? "–" : (st.upReset <= now ? "whole" : fmtMs(st.upReset - now)));
    var badge = $("lim-penalty");
    if (st.limPenalised && st.limForced > now) {
      badge.className = "badge bad";
      badge.innerHTML = "<span>penalty · lifts in " + fmtMs(st.limForced - now) + "</span>";
    } else {
      badge.className = "badge good";
      badge.innerHTML = "<span>no penalty</span>";
    }
  }

  function flag(ok, message) {
    $("poll-flag").className = ok ? "poll-flag" : "poll-flag bad";
    text("poll-text", message);
  }

  function poll() {
    fetch("/poll").then(function (res) {
      if (!res.ok) throw new Error("poll -> " + res.status);
      return res.json();
    }).then(function (data) {
      renderUpstream(data.upstream);
      renderLimiter(data.limiter);
      renderApp("alpha", data.alpha);
      renderApp("bravo", data.bravo);
      updateCountdowns();
      flag(true, "polling every 1.5s");
    }).catch(function (e) {
      flag(false, "poll failed: " + e.message);
    });
  }

  function post(path, body) {
    var init = { method: "POST" };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return fetch(path, init);
  }

  function wire(id, fn) { $(id).addEventListener("click", fn); }

  // ── Mock upstream controls ──────────────────────────────────────────────
  $("up-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    post("/upstream/configure", {
      limitPerWindow: Number($("up-limit").value),
      windowSeconds: Number($("up-window").value),
      processingMs: Number($("up-work").value)
    }).then(function (res) {
      text("up-error", res.ok ? "" : "configure failed (" + res.status + ")");
      poll();
    }).catch(function (e) { text("up-error", "error: " + e.message); });
  });
  wire("up-reset-btn", function () {
    post("/upstream/reset").then(function () { poll(); })
      .catch(function (e) { text("up-error", "error: " + e.message); });
  });

  // ── Limiter controls ────────────────────────────────────────────────────
  $("lim-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    post("/limiter/configure", {
      limitPerWindow: Number($("lim-limit").value),
      windowInMs: Number($("lim-window").value),
      concurrency: Number($("lim-conc").value)
    }).then(function (res) {
      return res.ok ? "" : res.text().then(function (t) { return "configure failed (" + res.status + "): " + t; });
    }).then(function (msg) { text("lim-error", msg); poll(); })
      .catch(function (e) { text("lim-error", "error: " + e.message); });
  });

  // ── Per-app controls ────────────────────────────────────────────────────
  function burst(app) {
    var n = $("n-" + app).value || "8";
    text(app + "-fb", "bursting " + app + " (n=" + n + ")…");
    post("/trigger/" + app + "?n=" + encodeURIComponent(n))
      .then(function (res) { return res.text().then(function (t) { return res.ok ? "burst started" : "trigger failed (" + res.status + "): " + t; }); })
      .then(function (msg) { text(app + "-fb", msg); })
      .catch(function (e) { text(app + "-fb", "error: " + e.message); });
  }
  function resetApp(app) {
    post("/reset/" + app).then(function () { text(app + "-fb", app + " status cleared"); poll(); })
      .catch(function (e) { text(app + "-fb", "error: " + e.message); });
  }
  wire("burst-alpha", function () { burst("alpha"); });
  wire("burst-bravo", function () { burst("bravo"); });
  wire("reset-alpha", function () { resetApp("alpha"); });
  wire("reset-bravo", function () { resetApp("bravo"); });

  poll();
  setInterval(poll, POLL_MS);
  setInterval(updateCountdowns, 500);
})();
</script>
</body>
</html>
`;
