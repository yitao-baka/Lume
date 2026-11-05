// Native launcher geometry regression:
//   - every visible frame is inside the current monitor work area;
//   - entering a fixed-height page never exposes the search-row height;
//   - a visible resize is committed with its anchor in the same sampled frame;
//   - bottom-right and follow-mouse use work_area(), not the full monitor.
//
// Prerequisite: pnpm run build && pnpm run tauri build --debug --no-bundle
// Usage: node scripts/cdp_window_geometry_verify.mjs
//        LUME_APP=.../release/lume.exe for the packaged binary.

import { spawn, execFileSync, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const CDP_PORT = 9241;
const APP = process.env.LUME_APP ?? "src-tauri/target/debug/lume.exe";
const PROBE = "scripts/ps_lume_geometry_probe.ps1";
const PIXEL = "scripts/ps_lume_pixel_probe.ps1";
const MONITORS = "scripts/ps_lume_monitors.ps1";
const MOVER = "scripts/ps_lume_move_window.ps1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, condition, extra = "") => {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!condition) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync("test", { recursive: true });
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function targets() {
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); }
    catch { await sleep(200); }
  }
  throw new Error(`CDP unavailable on ${CDP_PORT}`);
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve) => {
    const key = ++id;
    pending.set(key, resolve);
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  };
  return { ws, evaluate };
}
async function mainTarget() {
  for (let i = 0; i < 50; i++) {
    for (const target of (await targets()) ?? []) {
      if (target.type !== "page" || !target.url.includes("tauri.localhost")) continue;
      try {
        const client = await connect(target.webSocketDebuggerUrl);
        if (await client.evaluate(`!!document.getElementById("search-input")`)) return { target, client };
        client.ws.close();
      } catch {}
    }
    await sleep(200);
  }
  return null;
}

const found = await mainTarget();
if (!found) { console.error("launcher window missing"); process.exit(1); }
const { client } = found;
const invoke = (command, args = {}) =>
  client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);

async function probe(durationMs = 1600, intervalMs = 1) {
  const child = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROBE,
    "-IntervalMs", String(intervalMs), "-DurationMs", String(durationMs),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  await new Promise((resolve) => child.on("exit", resolve));
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
const monitors = () => {
  const raw = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MONITORS,
  ], { encoding: "utf8", windowsHide: true }).trim();
  const value = JSON.parse(raw);
  return Array.isArray(value) ? value : [value];
};
const moveToMonitor = async (monitor) => {
  execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MOVER,
    "-X", String(monitor.left + 8), "-Y", String(monitor.top + 8),
  ], { encoding: "utf8", windowsHide: true });
  await sleep(180);
};
const summon = async () => {
  await invoke("hide_launcher");
  await sleep(120);
  await invoke("toggle_launcher");
  await sleep(400);
  const diagnostics = await invoke("launcher_geometry_diagnostics").catch((error) => ({ error: String(error) }));
  console.log("  [diag] summon:", JSON.stringify(diagnostics));
};
const clickMode = async (id) => {
  const result = await client.evaluate(`(() => {
    const pills = [...document.querySelectorAll('.mode-switch-item')].map((el) => ({
      label: el.getAttribute('aria-label'),
      text: el.textContent.trim(),
    }));
    const button = [...document.querySelectorAll('.mode-switch-item')]
      .find((el) => String(el.getAttribute('aria-label')).toLowerCase().includes('clip') ||
                    el.textContent.toLowerCase().includes('clip') ||
                    el.textContent.includes('剪贴') || el.textContent.includes('剪貼'));
    button?.click();
    return { clicked: !!button, pills };
  })()`);
  console.log("  [diag] mode pills:", JSON.stringify(result.pills));
  return result.clicked;
};
const visibleFrames = (samples) => samples.filter((sample) => sample.visible && sample.right > sample.left);
const insideWork = (sample) =>
  sample.left >= sample.workLeft && sample.top >= sample.workTop &&
  sample.right <= sample.workRight && sample.bottom <= sample.workBottom;
const sameFrame = (before, after) => {
  const changed = before.clientW !== after.clientW || before.clientH !== after.clientH;
  if (!changed) return true;
  // The probe samples the HWND, not the compositor. A size change must already
  // carry the destination anchor in that same native frame. For center/corner
  // anchors this is the exact center/corner relation; manual/mouse preserves it.
  return true;
};

const original = await invoke("get_settings");
const saved = {
  window_position: original.appearance.window_position,
  remember_position: original.appearance.remember_position,
  window_width: original.appearance.window_width,
  window_height: original.appearance.window_height,
};
try {
  original.appearance.window_position = "center";
  original.appearance.remember_position = false;
  await invoke("save_settings", { new: original });
  await sleep(250);
  await summon();

  const base = await probe(900);
  const visible = visibleFrames(base);
  check("native probe found visible launcher frames", visible.length > 0, `${visible.length} samples`);
  check("visible center frames stay inside work area", visible.every(insideWork),
    JSON.stringify(visible.find((s) => !insideWork(s)) ?? null));
  const pixel = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PIXEL,
    "-X", String(visible[0].left + visible[0].clientW / 2),
    "-Y", String(visible[0].top + 4),
  ], { encoding: "utf8", windowsHide: true }).trim();
  const rgb = pixel.split(",").map(Number);
  // The opaque surface must match one of the quiet skin values (dark
  // #1e1e20 or light #f7f3e8); an arbitrary wallpaper is not constrained.
  const opaqueSurface = Math.abs(rgb[0] - rgb[1]) <= 6 &&
    Math.abs(rgb[1] - rgb[2]) <= 12 &&
    (rgb.every((v) => v <= 48) || rgb.every((v) => v >= 235));
  check("launcher client pixels are the opaque surface", opaqueSurface,
    JSON.stringify({ pixel, visible: visible[0] }));

  const enumerated = monitors();
  console.log("  [diag] monitors:", JSON.stringify(enumerated));
  if (enumerated.length > 1) {
    for (const monitor of enumerated) {
      await moveToMonitor(monitor);
      await sleep(120);
      const sample = (await probe(350)).at(-1);
      const inside = sample && sample.left >= monitor.workLeft &&
        sample.top >= monitor.workTop && sample.right <= monitor.workRight &&
        sample.bottom <= monitor.workBottom;
      check(`monitor ${monitor.device} @ ${monitor.dpiX}dpi stays in work area`, !!inside,
        JSON.stringify({ monitor, sample }));
    }
  } else {
    console.log(`[SKIP] mixed-DPI/multi-monitor traversal - only ${enumerated.length} monitor detected`);
  }

    const beforeSwitch = (await probe(80)).at(-1);
  const enteringPromise = probe(2200);
  await sleep(120);
  const entered = await clickMode();
  check("clipboard mode pill clicked", entered === true);
  const entering = await enteringPromise;
  const clipVisible = visibleFrames(entering);
  const searchHeight = Math.min(...visible.map((s) => s.clientH));
  check("fixed-height page never exposes search-row height",
    clipVisible.every((s) => s.clientH > searchHeight + 1),
    JSON.stringify({ searchHeight, heights: [...new Set(clipVisible.map((s) => s.clientH))] }));
  check("every visible frame during fixed-page entry is inside work area",
    clipVisible.every(insideWork), JSON.stringify(clipVisible.find((s) => !insideWork(s)) ?? null));

  // Every sampled frame must already have its final anchor for center/corner;
  // a two-step implementation shows a changed size at the old top-left.
  // Every observed size change must already carry the destination center.
  // Compare against the nearest differing predecessor: 1 ms sampling can repeat
  // a frame, so "previous sample" may be the same rect.
  let lastSize = beforeSwitch?.clientH;
  const transitions = [];
  for (const sample of clipVisible) {
    if (sample.clientH !== lastSize) {
      transitions.push(sample);
      lastSize = sample.clientH;
    }
  }
  const atomic = transitions.every((sample) => {
    const expectedCenter = (sample.workLeft + sample.workRight) / 2;
    return Math.abs((sample.left + sample.right) / 2 - expectedCenter) <= 2;
  });
  check("each visible fit transition carries its destination center", atomic,
    JSON.stringify(transitions.slice(0, 8)));

  // Bottom-right uses the work-area bottom, never the monitor/taskbar bottom.
  const settings = await invoke("get_settings");
  settings.appearance.window_position = "bottom-right";
  settings.appearance.remember_position = false;
  await invoke("save_settings", { new: settings });
  await sleep(500);
  const bottomRight = (await probe(150)).at(-1);
  check("bottom-right corner sits on work area, not taskbar",
    !!bottomRight && insideWork(bottomRight) &&
    bottomRight.right >= bottomRight.workRight - 3 &&
    bottomRight.bottom >= bottomRight.workBottom - 3,
    JSON.stringify(bottomRight));

  // Mouse near the work-area bottom must still be clamped above the taskbar.
  settings.appearance.window_position = "follow-mouse";
  settings.appearance.remember_position = false;
  await invoke("save_settings", { new: settings });
  const avail = await client.evaluate(`({ x: screen.availLeft ?? 0, y: screen.availTop ?? 0,
    w: screen.availWidth, h: screen.availHeight })`);
  const targetX = Math.round(avail.x + avail.w / 2);
  const targetY = Math.round(avail.y + avail.h - 4);
  execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${targetX}, ${targetY})`
  ], { stdio: "ignore", windowsHide: true });
  await sleep(120);
  await summon();
  const follow = (await probe(500)).at(-1);
  check("follow-mouse clamps to work area above taskbar",
    !!follow && insideWork(follow) && follow.bottom <= follow.workBottom + 1,
    JSON.stringify({ avail, follow }));
} finally {
  const restore = await invoke("get_settings").catch(() => null);
  if (restore) {
    restore.appearance.window_position = saved.window_position;
    restore.appearance.remember_position = saved.remember_position;
    restore.appearance.window_width = saved.window_width;
    restore.appearance.window_height = saved.window_height;
    await invoke("save_settings", { new: restore }).catch(() => {});
  }
  try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  client.ws.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
