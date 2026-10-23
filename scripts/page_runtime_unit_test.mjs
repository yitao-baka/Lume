// Page Runtime unit checks. Loads the TypeScript self-test through Vite SSR so
// the repository needs no extra test runner dependency.
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  appType: "custom",
  clearScreen: false,
  server: { middlewareMode: true },
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const mod = await server.ssrLoadModule("/src/page-runtime/selftest.ts");
  const sync = mod.runPageRuntimeSelfTests();
  const asyncChecks = await mod.runPageRuntimeAsyncSelfTests();
  for (const name of [...sync, ...asyncChecks]) console.log(`PASS ${name}`);
  console.log(`PAGE RUNTIME UNIT PASS (${sync.length + asyncChecks.length})`);
} finally {
  await server.close();
}
