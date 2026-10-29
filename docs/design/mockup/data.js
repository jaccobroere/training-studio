// Shared DEMO content for all mockup directions. Not real athlete data.
// Load with <script src="../data.js"></script>; exposes window.DEMO.
(function () {
  let s = 42;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const noise = (a) => (rnd() - 0.5) * 2 * a;

  const week = {
    label: "Week 3 · 11–17 Jan 2027",
    monday: "2027-01-11",
    phase: "Early marathon",
    season: "Winter → Rotterdam",
    weeksToRace: 13,
    revision: "r42 · 14:02 · Chat",
    today: "2027-01-13", // Wednesday
    targets: [
      { key: "Running", planned: 50, done: 18, unit: "km", range: "45–55" },
      { key: "Long run", planned: 24, done: 0, unit: "km", range: "24" },
      { key: "Skate", planned: 1, done: 1, unit: "session" },
      { key: "Lower strength", planned: 1, done: 0, unit: "session" },
      { key: "Handstand", planned: 5, done: 2, unit: "×", range: "4–6", quiet: true },
      { key: "Mobility", planned: 4, done: 1, unit: "×", range: "3–5", quiet: true },
    ],
    gym: { last: "2 Jan · Gym A", next: "Gym B", window: "16–23 Jan" },
    days: [
      { date: "2027-01-11", dow: "Mon", d: 11, sessions: [
        { id: "s1", sport: "Skate", title: "Skate lesson + 6 laps", rx: "Lesson 60′ · 6×400 m flying", prio: "A", status: "done", planned: "90′", actual: "92′ · best lap 38.4 s", rpe: 7 },
      ]},
      { date: "2027-01-12", dow: "Tue", d: 12, sessions: [
        { id: "s2", sport: "Run", title: "Easy run", rx: "10 km conversational · RPE 2–3", prio: "B", status: "done", planned: "10 km", actual: "10.3 km · 52:10 · 5:04/km", rpe: 3 },
        { id: "s3", sport: "Upper", title: "Upper / calisthenics", rx: "Weighted pull-ups 4×5 · dips 3×8 · rows", prio: "B", status: "done", planned: "45′", actual: "40′", rpe: 6 },
        { id: "s4", sport: "Skill", title: "Handstand", rx: "12′ wall + freestanding attempts", prio: "C", status: "done", planned: "12′", actual: "12′ · best hold 14 s" },
      ]},
      { date: "2027-01-13", dow: "Wed", d: 13, today: true, sessions: [
        { id: "s5", sport: "Run", title: "Threshold", rx: "WU 3 km · 3×10′ @ threshold, 2′ jog · CD 2 km", prio: "A", status: "partial", planned: "12 km", actual: "7.9 km · stopped after rep 2", rpe: 8, changed: true },
        { id: "s6", sport: "Lower", title: "Lower main", rx: "Bounds 3×4 · trap-bar 4×4 · BSS 3×6 · RDL 3×6 · calves", prio: "A", status: "planned", planned: "60′" },
      ]},
      { date: "2027-01-14", dow: "Thu", d: 14, rest: false, sessions: [
        { id: "s7", sport: "Mobility", title: "Mobility", rx: "15′ ankles · hips · T-spine", prio: "C", status: "planned", planned: "15′" },
      ]},
      { date: "2027-01-15", dow: "Fri", d: 15, sessions: [
        { id: "s8", sport: "Run", title: "Easy / steady", rx: "12 km, last 3 km steady", prio: "B", status: "planned", planned: "12 km" },
        { id: "s9", sport: "Skill", title: "Handstand", rx: "12′", prio: "C", status: "planned", planned: "12′" },
      ]},
      { date: "2027-01-16", dow: "Sat", d: 16, sessions: [] , restLabel: "Rest" },
      { date: "2027-01-17", dow: "Sun", d: 17, sessions: [
        { id: "s10", sport: "Run", title: "Long run", rx: "24 km easy · RPE 3", prio: "A", status: "planned", planned: "24 km", changed: true, note: "Moved from Sat by chat" },
      ]},
    ],
    unscheduled: [
      { id: "u1", sport: "Mobility", title: "Mobility", rx: "15′ hips / adductors", prio: "C", status: "planned", planned: "15′" },
      { id: "u2", sport: "Skill", title: "Handstand", rx: "10′", prio: "C", status: "planned", planned: "10′" },
    ],
  };

  const chat = {
    title: "Long run & Thursday skate",
    scope: "Week of 11 Jan · Early marathon",
    dataThrough: "Garmin data through 13 Jan 07:12",
    messages: [
      { role: "user", scope: "11–17 Jan", text: "Club added an extra skate session Saturday morning. Can I make that work with the long run?" },
      { role: "tool", text: "Read week 11–17 Jan · 10 sessions" },
      { role: "tool", text: "Read principles · v7" },
      { role: "assistant", text: "Yes, if the long run moves. Saturday skate + Saturday long run would put two big leg loads on one day, right after Wednesday's lower session. Your principles say to keep roughly three hard leg days and protect the long run in this phase.", cite: [] },
      { role: "proposal", title: "Proposal · 2 changes", items: [
        { op: "add", text: "Sat 16 · Skate — aerobic laps, 60′ · B" },
        { op: "move", text: "Long run 24 km · Sat 16 → Sun 17" },
      ], note: "Hard leg days stay at 3: Mon skate, Wed threshold + lower, Sat skate. Sunday long run follows a skate day — keep Saturday aerobic, not speed." },
      { role: "user", scope: "11–17 Jan", text: "Just move the long run for now, I'll confirm the skate later." },
      { role: "change", title: "Updated 11–17 Jan", rev: "r42", items: [
        { op: "move", text: "Long run 24 km · Sat 16 → Sun 17" },
      ], undo: true },
      { role: "assistant", text: "Done. Saturday is free for the skate if it happens. One thing from Garmin: your easy-run HR at 5:05/km has been ~4 bpm lower than in December [1], which fits the added volume — small sample (n=6), so treat it as a hint.", cite: [{ n: 1, label: "Analysis · easy-run HR at pace, 8 Dec–12 Jan" }] },
    ],
    draft: "What would a cutback week look like after this one?",
  };

  // 90 days of daily wellness, ending 12 Jan 2027. A few null gaps (watch not worn).
  const days = [];
  const start = new Date(Date.UTC(2026, 9, 15));
  for (let i = 0; i < 90; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    const gap = (i >= 31 && i <= 33) || i === 61;
    const trend = i / 90;
    days.push({
      date: d.toISOString().slice(0, 10),
      hrv: gap ? null : Math.round(58 + trend * 6 + noise(7) + Math.sin(i / 5) * 2),
      rhr: gap ? null : Math.round(48 - trend * 2 + noise(2)),
      sleepH: gap ? null : +(7.3 + noise(0.8) + (d.getUTCDay() === 6 ? 0.6 : 0)).toFixed(2),
      bed: gap ? null : +(23.2 + noise(0.6)).toFixed(2),
      wake: gap ? null : +(7.0 + noise(0.5)).toFixed(2),
      steps: gap ? null : Math.round(9500 + noise(3500)),
    });
  }

  // 16 weeks of weekly volume by sport (km for run; minutes for others)
  const weeks = [];
  for (let w = 0; w < 16; w++) {
    const deload = w % 4 === 3;
    const run = Math.round((32 + w * 1.4) * (deload ? 0.8 : 1) + noise(3));
    weeks.push({
      label: "W" + (w - 12 < 1 ? 40 + w : w - 12),
      runKm: w === 15 ? 18 : run,
      runPlanned: w === 15 ? 50 : null,
      longKm: Math.round((16 + w * 0.6) * (deload ? 0.85 : 1)),
      skateMin: Math.round(95 + noise(25)),
      strengthMin: Math.round(70 + noise(25)),
    });
  }

  // One run's streams: threshold session, 1 Hz downsampled to 10 s (≈ 60 min)
  const run = [];
  for (let t = 0; t <= 3600; t += 10) {
    let phase = t < 900 ? "wu" : t < 3300 ? ((t - 900) % 720 < 600 ? "rep" : "rec") : "cd";
    const pace = phase === "rep" ? 262 + noise(5) : phase === "rec" ? 350 + noise(12) : 318 + noise(8);
    const hr = phase === "rep" ? 168 + ((t - 900) % 720) / 60 + noise(2) : phase === "rec" ? 150 + noise(3) : 142 + noise(3) + (t < 900 ? t / 120 : 0);
    run.push({ t, pace: Math.round(pace), hr: Math.round(hr), elev: Math.round(4 + Math.sin(t / 400) * 3 + noise(0.5)), phase });
  }

  const skateLaps = [];
  for (let i = 0; i < 24; i++) skateLaps.push({ session: "S" + (Math.floor(i / 6) + 1), lap: (i % 6) + 1, s: +(40.2 - i * 0.08 + noise(0.7)).toFixed(1), method: "flying" });

  window.DEMO = { week, chat, days, weeks, run, skateLaps, note: "Demo data — not real measurements" };
})();
