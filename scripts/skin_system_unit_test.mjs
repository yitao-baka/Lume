// Skin registry and accent derivation unit checks through Vite SSR.
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  appType: "custom",
  clearScreen: false,
  server: { middlewareMode: true },
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

try {
  const registry = await server.ssrLoadModule("/src/skins/registry.ts");
  const accent = await server.ssrLoadModule("/src/skins/accent.ts");

  check("registry exposes Quiet and Chromatic", JSON.stringify(registry.SKIN_IDS) === JSON.stringify(["quiet", "chromatic"]));
  check("unknown skins normalize to Quiet", registry.normalizeSkin("unknown") === "quiet");
  check("Quiet surfaces match the shared metadata", registry.skinSurface("quiet", "dark") === "#1e1e20" && registry.skinSurface("quiet", "light") === "#fbfbfd");
  check("Chromatic surfaces match the shared metadata", registry.skinSurface("chromatic", "dark") === "#1e1e20" && registry.skinSurface("chromatic", "light") === "#f3efe6");
  check("clipboard row heights are skin-owned",
    registry.clipboardRowHeight("quiet", "clipboard-list") === 52 &&
    registry.clipboardRowHeight("quiet", "clipboard-compact") === 44 &&
    registry.clipboardRowHeight("chromatic", "clipboard-list") === 56 &&
    registry.clipboardRowHeight("chromatic", "clipboard-compact") === 48);
  check("accent normalization accepts 3/6 digit hex only",
    accent.normalizeAccent("#5cf") === "#55ccff" &&
    accent.normalizeAccent("AABBCC") === "#aabbcc" &&
    accent.normalizeAccent("rgb(0 0 0)") === "");
  check("native accents follow skin + mode",
    accent.nativeAccent("quiet", "dark") === "#5ac8fa" &&
    accent.nativeAccent("quiet", "light") === "#0969da" &&
    accent.nativeAccent("chromatic", "light") === "#64796d");

  for (const skin of ["quiet", "chromatic"]) {
    for (const mode of ["dark", "light"]) {
      const tokens = accent.deriveAccentTokens("#d96c95", mode, skin);
      const anchor = registry.skinAccentAnchor(skin, mode);
      check(`${skin}/${mode} accent tokens keep contrast floors`,
        !!tokens &&
        accent.accentContrast(tokens.accent, anchor) >= 3 &&
        accent.accentContrast(tokens.text, anchor) >= 4.5 &&
        accent.accentContrast(tokens.border, anchor) >= 3 &&
        accent.accentContrast(tokens.focus, anchor) >= 3 &&
        accent.accentContrast(tokens.on, tokens.accent) >= 4.5,
        JSON.stringify(tokens));
    }
  }
} finally {
  await server.close();
}

console.log(`SKIN UNIT ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
