/* Direction C — shared render helpers. Uses window.DEMO only. */
const D = window.DEMO;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join("") : vals[i] ?? "") : ""), "");

const ICON = {
  week: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="13" rx="1"/><path d="M3 8h14M7 2.5v3M13 2.5v3M6 11h3M6 14h6"/></svg>',
  health: '<svg viewBox="0 0 20 20"><path d="M2 11h3.5l2-5 3 9 2.2-6 1.3 2H18"/></svg>',
  principles: '<svg viewBox="0 0 20 20"><path d="M5 3h8l3 3v11H5z"/><path d="M8 9h5M8 12h5M8 15h3"/></svg>',
  library: '<svg viewBox="0 0 20 20"><path d="M4 3v14M8 3v14M12 4l3.5 12.5"/></svg>',
  data: '<svg viewBox="0 0 20 20"><ellipse cx="10" cy="5" rx="6" ry="2"/><path d="M4 5v10c0 1.1 2.7 2 6 2s6-.9 6-2V5M4 10c0 1.1 2.7 2 6 2s6-.9 6-2"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3 8.5 3.2 3L13 4.5"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/></svg>',
  hist: '<svg viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3"/></svg>',
  console: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  send: '<svg viewBox="0 0 16 16"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M5.5 4 2.5 7l3 3"/><path d="M2.5 7h7a3.5 3.5 0 0 1 0 7H7"/></svg>',
  grip: '<svg viewBox="0 0 16 16"><circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/></svg>',
};

const NAV = [["week", "Week"], ["health", "Health"], ["principles", "Principles"], ["library", "Library"], ["data", "Data"]];
function rail(active) {
  return h`<nav class="rail" aria-label="Destinations">
    <div class="mark" title="Training Studio"><i></i></div>
    ${NAV.map(([k, l]) => h`<a href="#" ${k === active ? 'aria-current="page"' : ""}>${ICON[k]}${l}</a>`)}
    <div class="spacer"></div>
    <div class="demo-tag">DEMO<br>DATA</div>
  </nav>`;
}
function tabbar(active) {
  return h`<nav class="tabbar" aria-label="Destinations">
    ${NAV.map(([k, l]) => h`<a href="#" ${k === active ? 'aria-current="page"' : ""}>${ICON[k]}<span>${l}</span></a>`)}
  </nav>`;
}

const SPORT = { Run: "RUN", Skate: "SKT", Upper: "UPR", Lower: "LWR", Mobility: "MOB", Skill: "SKL" };
const STATUS = { done: ["●", "Done"], partial: ["◐", "Partial"], planned: ["○", "Planned"], skipped: ["⊘", "Skipped"] };
const status = (s) => h`<span class="st ${s}"><span class="g" aria-hidden="true">${STATUS[s][0]}</span>${STATUS[s][1]}</span>`;

/* ---------- Targets strip: channel meters ---------- */
function meter(t) {
  const [lo, hi] = t.range ? t.range.split("–").map(Number) : [t.planned, t.planned];
  if (t.unit === "km") {
    const max = Math.max(hi || t.planned, t.planned) * 1.1;
    const segs = 28, per = max / segs;
    let cells = "";
    for (let i = 0; i < segs; i++) {
      const v0 = i * per, v1 = (i + 1) * per;
      const on = v1 <= t.done + per * 0.001;
      const inRange = t.range && v1 > lo && v0 < (hi || lo);
      cells += `<i class="${on ? "on" : ""} ${inRange ? "rng" : ""}"></i>`;
    }
    const planPos = (t.planned / max) * 100;
    return `<div class="meter km" style="--plan:${planPos}%">${cells}<b class="plan-tick" title="planned ${t.planned} km"></b></div>`;
  }
  const n = Math.max(hi || t.planned, t.planned);
  let cells = "";
  for (let i = 0; i < n; i++) {
    const on = i < t.done, planned = i < t.planned, opt = t.range && i >= lo && i < hi && i >= t.planned;
    cells += `<i class="${on ? "on" : ""} ${planned ? "pl" : ""} ${opt || (t.range && i >= lo) ? "opt" : ""}"></i>`;
  }
  return `<div class="meter cnt">${cells}</div>`;
}
function targets() {
  const w = D.week;
  return h`<section class="targets" aria-label="Week targets">
    ${w.targets.map((t) => h`<div class="ch ${t.quiet ? "quiet" : ""}">
      <div class="ch-hd"><span class="silk">${t.key}</span></div>
      <div class="ch-val mono"><span class="done-v">${t.done}</span><span class="plan-v">/ ${t.planned}${t.unit === "km" ? " km" : t.unit === "×" ? "×" : ""}</span></div>
      ${meter(t)}
      <div class="ch-rng mono">${t.range && t.range !== String(t.planned) ? "range " + t.range : "target"}</div>
    </div>`)}
    <div class="ch gym">
      <div class="ch-hd"><span class="silk">Gym cycle</span></div>
      <div class="gym-l mono">Last&nbsp; ${w.gym.last}</div>
      <div class="gym-l mono">Next&nbsp; ${w.gym.next}</div>
      <div class="gym-l mono">Window ${w.gym.window}</div>
    </div>
  </section>`;
}

/* ---------- Week timetable ---------- */
function sessionRow(s, day, mobile) {
  const actual = s.actual ? h`<span class="act">${esc(s.actual)}</span>` : `<span class="act none">—</span>`;
  const doneKey = s.status === "planned"
    ? h`<button class="key done-key" aria-label="Mark ${esc(s.title)} done">${ICON.check}<span>Done</span></button>`
    : h`<button class="key done-key is-latched" aria-pressed="true" aria-label="${esc(s.title)} logged">${ICON.check}<span>Logged</span></button>`;
  return h`<div class="sess prio-${s.prio} ${s.changed ? "changed" : ""} st-${s.status}" tabindex="0">
    <span class="grip" aria-hidden="true">${ICON.grip}</span>
    <span class="sport" title="${s.sport}">${SPORT[s.sport]}</span>
    <div class="what">
      <div class="ttl">${esc(s.title)} ${s.changed ? h`<span class="chg-tag mono">chat · r42</span>` : ""}</div>
      <div class="rx">${esc(s.rx)}${s.note ? h` <span class="note">— ${esc(s.note)}</span>` : ""}</div>
    </div>
    <div class="pa mono"><span class="pl"><em>P</em>${esc(s.planned)}</span><span class="ac"><em>A</em>${actual}${s.rpe ? h` <span class="rpe">RPE ${s.rpe}</span>` : ""}</span></div>
    <span class="prio ${s.prio}" title="Priority ${s.prio}">${s.prio}</span>
    ${status(s.status)}
    <div class="acts">${doneKey}<button class="key sq flat" aria-label="Move to… / more">${ICON.more}</button></div>
  </div>`;
}
function dayRow(d, mobile) {
  const sessions = d.sessions.length
    ? d.sessions.map((s) => sessionRow(s, d, mobile)).join("")
    : h`<div class="sess empty"><span class="rest mono">${d.restLabel || "No sessions"}</span><button class="key flat add-slot">${ICON.plus}Add</button></div>`;
  return h`<div class="day ${d.today ? "today" : ""}" ${d.today ? 'aria-current="date"' : ""}>
    <div class="dlab"><span class="dow">${d.dow}</span><span class="dn mono">${d.d}</span>${d.today ? '<span class="tdy">Today</span>' : ""}<span class="cnt mono">${d.sessions.length ? d.sessions.length + "×" : ""}</span></div>
    <div class="dsess">${sessions}</div>
  </div>`;
}
function weekGrid(mobile) {
  const w = D.week;
  return h`<div class="grid-hd" aria-hidden="true">
      <span class="silk">Day</span><span></span><span class="silk">Sport</span><span class="silk">Session · prescription</span><span class="silk">Plan / actual</span><span class="silk">Pri</span><span class="silk">Status</span><span class="silk" style="text-align:right;padding-right:6px">Log</span>
    </div>
    <div class="days">${w.days.map((d) => dayRow(d, mobile))}</div>
    <div class="tray">
      <div class="tray-hd"><span class="silk">Unscheduled</span><span class="mono tray-n">${w.unscheduled.length}</span><span class="tray-hint">Drag onto a day, or use “Move to…”</span></div>
      <div class="tray-items">${w.unscheduled.map((s) => h`<div class="chip-sess prio-${s.prio}" tabindex="0"><span class="grip">${ICON.grip}</span><span class="sport">${SPORT[s.sport]}</span><span class="t">${esc(s.title)}</span><span class="rx mono">${esc(s.rx)}</span><span class="prio ${s.prio}">${s.prio}</span><button class="key sq flat" aria-label="Move to…">${ICON.more}</button></div>`)}</div>
    </div>`;
}

/* ---------- Chat console ---------- */
function thread() {
  const c = D.chat;
  let toolBuf = [];
  const out = [];
  const flushTools = () => {
    if (!toolBuf.length) return;
    out.push(h`<details class="tools"><summary><span class="mono">${ICON.right}${toolBuf.length} tool calls</span><span class="tl-sum">${toolBuf.map((t) => esc(t.text.split(" · ")[0])).join(" · ")}</span></summary>${toolBuf.map((t) => `<div class="tl mono">▸ ${esc(t.text)}</div>`).join("")}</details>`);
    toolBuf = [];
  };
  c.messages.forEach((m) => {
    if (m.role === "tool") { toolBuf.push(m); return; }
    flushTools();
    if (m.role === "user") out.push(h`<div class="msg user"><div class="u-meta"><span class="scope-chip mono">⌖ ${esc(m.scope)}</span></div><p>${esc(m.text)}</p></div>`);
    if (m.role === "assistant") {
      let txt = esc(m.text).replace(/\[(\d)\]/g, '<button class="cite mono" aria-label="Source $1">$1</button>');
      out.push(h`<div class="msg asst"><p>${txt}</p>${m.cite.length ? h`<ol class="srcs">${m.cite.map((s) => h`<li><span class="cite mono">${s.n}</span>${esc(s.label)}</li>`)}</ol>` : ""}</div>`);
    }
    if (m.role === "proposal") out.push(h`<div class="receipt proposal">
      <div class="rc-hd mono"><span>PROPOSAL</span><span class="fill"></span><span>${m.items.length} CHANGES</span></div>
      <div class="rc-body">${m.items.map((it) => h`<div class="rc-op mono"><span class="op op-${it.op}">${it.op === "add" ? "+ ADD" : "→ MOVE"}</span><span>${esc(it.text)}</span></div>`)}</div>
      <p class="rc-note">${esc(m.note)}</p>
      <div class="rc-ft"><span class="mono rc-state">Not applied</span><span class="fill"></span><button class="key">Discard</button><button class="key ink">Apply 2</button></div>
    </div>`);
    if (m.role === "change") out.push(h`<div class="receipt change">
      <div class="rc-hd mono"><span>APPLIED · ${esc(m.title.toUpperCase())}</span><span class="fill"></span><span>${m.rev}</span></div>
      <div class="rc-body diff mono">
        <div class="d-row rm"><span class="dg">−</span><span class="dd">SAT 16</span><span>Long run 24 km · A</span></div>
        <div class="d-row ad"><span class="dg">+</span><span class="dd">SUN 17</span><span>Long run 24 km · A</span></div>
      </div>
      <div class="rc-ft"><span class="mono rc-state">${esc(D.week.revision)}</span><span class="fill"></span><button class="key flat">Show in week</button><button class="key">${ICON.undo}Undo</button></div>
    </div>`);
  });
  return out.join("");
}
function consoleHeader(mobile) {
  const c = D.chat, w = D.week;
  return h`<div class="con-hd">
      <span class="silk con-name">Console</span>
      <span class="con-title">${esc(c.title)}</span>
      <span class="fill"></span>
      <button class="key sq flat" aria-label="Threads">${ICON.hist}</button>
      <button class="key flat">${ICON.plus}New</button>
      <button class="key sq flat" aria-label="Close console">${mobile ? ICON.down : ICON.close}</button>
    </div>
    <div class="scope screen">
      <dl class="readout">
        <div><dt>Scope · week</dt><dd>11–17 Jan</dd></div>
        <div><dt>Phase</dt><dd>${esc(w.phase)}</dd></div>
        <div><dt>Data through</dt><dd>13 Jan 07:12<small>Garmin</small></dd></div>
      </dl>
    </div>`;
}
function composer() {
  return h`<div class="composer">
    <div class="cmp-box"><span class="scope-chip mono">⌖ 11–17 Jan</span><div class="cmp-text">${esc(D.chat.draft)}<span class="caret"></span></div></div>
    <div class="cmp-ft"><span class="mono cmp-hint">↵ send · ⇧↵ newline</span><span class="fill"></span><button class="key ink">${ICON.send}Send</button></div>
  </div>`;
}
