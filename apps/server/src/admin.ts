/** HTML for the admin console served at /admin. */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>hostc 管理控制台</title>
<style>
:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
  --bg: Canvas;
  --text: CanvasText;
  --muted: #71717a;
  --border: color-mix(in oklab, CanvasText 15%, transparent);
  --card: color-mix(in oklab, CanvasText 4%, Canvas);
  --accent: #ea580c;
  --ok: #16a34a;
  --warn: #d97706;
  --bad: #dc2626;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
.sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; }
input[type=password] {
  width: 100%; padding: 0.55rem 0.7rem; font-size: 1rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
}
button {
  padding: 0.5rem 0.9rem; font-size: 0.9rem; cursor: pointer;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 40%, transparent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 0.6rem; align-items: center; }
.grow { flex: 1; }
.error { color: var(--bad); font-size: 0.9rem; margin-top: 0.6rem; min-height: 1.2em; }
.toolbar { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0 0.75rem; font-size: 0.9rem; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; font-size: 0.8rem; }
td.url a { font-family: ui-monospace, monospace; font-size: 0.85rem; color: var(--text); word-break: break-all; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.4rem; }
.dot.online { background: var(--ok); }
.dot.offline { background: var(--warn); }
.dot.waiting { background: var(--muted); }
.muted { color: var(--muted); }
.empty { color: var(--muted); text-align: center; padding: 2rem 0; }
footer { margin-top: 2rem; font-size: 0.8rem; color: var(--muted); }
footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>hostc 管理控制台</h1>
  <p class="sub">自托管隧道服务 · <span id="host"></span></p>

  <section id="login-card" class="card">
    <label for="token">管理密钥（ADMIN_TOKEN）</label>
    <div class="row">
      <input id="token" type="password" placeholder="输入管理密钥" autocomplete="off">
      <button class="primary" id="login">进入</button>
    </div>
    <div class="error" id="login-error"></div>
  </section>

  <section id="panel" hidden>
    <div class="toolbar">
      <span id="stats" class="grow"></span>
      <span class="muted">每 10 秒自动刷新</span>
      <button id="refresh">刷新</button>
      <button id="logout">退出</button>
    </div>
    <div class="card" style="padding: 0.25rem 0.75rem 0.5rem;">
      <table>
        <thead><tr><th>状态</th><th>隧道 URL</th><th>创建时间</th><th>连接时间</th><th></th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
      <div class="empty" id="empty" hidden>当前没有隧道</div>
    </div>
  </section>

  <footer>Served by <a href="https://github.com/akazwz/hostc">hostc</a> · <a href="/">返回首页</a></footer>
</main>
<script type="module">
const $ = (id) => document.getElementById(id);
const key = "hostc-admin-token";
$("host").textContent = location.host;

$("login").onclick = async () => {
  $("login-error").textContent = "";
  const token = $("token").value.trim();
  if (!token) return;
  const ok = await check(token);
  if (ok.success) {
    localStorage.setItem(key, token);
    show();
  } else {
    $("login-error").textContent = "密钥错误";
  }
};
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login").click(); });
$("logout").onclick = () => { localStorage.removeItem(key); location.reload(); };
$("refresh").onclick = () => load();

async function check(token) {
  const r = await fetch("/api/admin/tunnels", { headers: { authorization: "Bearer " + token } });
  return { success: r.ok };
}

function show() {
  $("login-card").hidden = true;
  $("panel").hidden = false;
  load();
  setInterval(load, 10000);
}

async function load() {
  const token = localStorage.getItem(key);
  if (!token) return;
  const r = await fetch("/api/admin/tunnels", { headers: { authorization: "Bearer " + token } });
  if (r.status === 401 || r.status === 403) {
    localStorage.removeItem(key);
    location.reload();
    return;
  }
  const data = await r.json();
  render(data.tunnels ?? []);
}

function render(tunnels) {
  const online = tunnels.filter((t) => t.connectedAt && !t.disconnectedAt);
  const waiting = tunnels.filter((t) => !t.connectedAt);
  $("stats").textContent = \`共 \${tunnels.length} 条 · 在线 \${online.length} · 等待连接 \${waiting.length}\`;
  const tbody = $("tbody");
  tbody.textContent = "";
  $("empty").hidden = tunnels.length > 0;
  for (const t of tunnels) {
    const tr = document.createElement("tr");

    const status = document.createElement("td");
    let cls = "waiting";
    let label = "等待连接";
    if (t.disconnectedAt) {
      cls = "offline";
      label = "已断开";
    } else if (t.connectedAt) {
      cls = "online";
      label = "在线";
    }
    status.innerHTML = \`<span class="dot \${cls}"></span>\${label}\`;

    const url = document.createElement("td");
    url.className = "url";
    const a = document.createElement("a");
    a.href = t.url;
    a.target = "_blank";
    a.textContent = t.url;
    url.appendChild(a);

    const created = document.createElement("td");
    created.className = "muted";
    created.textContent = fmt(t.createdAt);

    const connected = document.createElement("td");
    connected.className = "muted";
    connected.textContent = t.connectedAt ? fmt(t.connectedAt) : "—";

    const actions = document.createElement("td");
    const copy = document.createElement("button");
    copy.textContent = "复制";
    copy.onclick = () => {
      navigator.clipboard.writeText(t.url).then(() => {
        copy.textContent = "已复制";
        setTimeout(() => (copy.textContent = "复制"), 1500);
      });
    };
    const kick = document.createElement("button");
    kick.textContent = "下线";
    kick.className = "danger";
    kick.onclick = async () => {
      if (!confirm("确定下线该隧道？客户端会立即断开。")) return;
      kick.disabled = true;
      const r = await fetch(\`/api/admin/tunnels/\${t.id}/kick\`, {
        method: "POST",
        headers: { authorization: "Bearer " + localStorage.getItem(key) },
      });
      kick.disabled = false;
      if (r.ok) { kick.textContent = "已下线"; load(); }
      else { kick.textContent = "失败"; }
    };
    actions.appendChild(copy);
    actions.appendChild(kick);

    tr.append(status, url, created, connected, actions);
    tbody.appendChild(tr);
  }
}

function fmt(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
}

const saved = localStorage.getItem(key);
if (saved) {
  check(saved).then((r) => {
    if (r.success) { $("token").value = saved; show(); }
    else localStorage.removeItem(key);
  });
}
</script>
</body>
</html>`;
