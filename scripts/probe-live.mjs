const RS = "\x1e";
const topics = [
  "Heartbeat",
  "CarData.z",
  "Position.z",
  "ExtrapolatedClock",
  "TopThree",
  "TimingStats",
  "TimingAppData",
  "WeatherData",
  "TrackStatus",
  "DriverList",
  "RaceControlMessages",
  "SessionInfo",
  "SessionData",
  "LapCount",
  "TimingData",
  "TeamRadio",
  "SessionStatus",
];
const neg = await fetch("https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1", { method: "POST" });
const cookie = neg.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const j = await neg.json();
const ws = new WebSocket(`wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(j.connectionToken)}`, {
  headers: { Cookie: cookie },
});
let n = 0;
ws.onopen = () => {
  console.log("WS open");
  ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
};
ws.onerror = (e) => console.log("WS error", e.message ?? e);
ws.onclose = (e) => {
  console.log("WS close", e.code, e.reason);
  process.exit(0);
};
ws.onmessage = (ev) => {
  for (const part of String(ev.data).split(RS).filter(Boolean)) {
    const m = JSON.parse(part);
    n++;
    if (n === 1) {
      console.log("handshake:", part);
      ws.send(JSON.stringify({ type: 1, invocationId: "1", target: "Subscribe", arguments: [topics] }) + RS);
      continue;
    }
    if (m.type === 6) {
      continue;
    }
    if (m.type === 3) {
      if (m.error) {
        console.log("Subscribe ERROR:", m.error);
        continue;
      }
      const r = m.result ?? {};
      console.log("Subscribe result topics:");
      for (const t of topics) {
        const v = r[t];
        console.log(
          "  ",
          t.padEnd(22),
          v === undefined
            ? "-- AUSENTE"
            : typeof v === "string"
              ? `string(${v.length})`
              : `obj ${JSON.stringify(v).length}b  ${JSON.stringify(v).slice(0, 110)}`,
        );
      }
      continue;
    }
    console.log("msg type", m.type, m.target ?? "", JSON.stringify(m.arguments ?? m).slice(0, 200));
  }
};
setTimeout(() => {
  console.log("fin (20s), mensajes:", n);
  ws.close();
  process.exit(0);
}, 20000);
