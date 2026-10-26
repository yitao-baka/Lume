// Machine-readable host behavior contract check. Runs before every frontend
// production build so implementation and public plugin docs cannot silently
// drift on the safety-sensitive behaviors listed in PLUGIN_HOST_BEHAVIOR.json.
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("docs/PLUGIN_HOST_BEHAVIOR.json", "utf8"));
const read = (path) => readFileSync(path, "utf8");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(contract.api === 2, "host contract api must stay 2");
check(contract.disabledPlugin.unloadsLogicFrame === true, "disabled plugins must unload their logic frame");
check(contract.disabledPlugin.revokesCapabilityTokens === true, "disabled plugins must lose capability tokens");
check(contract.disabledPlugin.receivesLifecycleHooks === false, "disabled plugins must not receive lifecycle hooks");
check(contract.disabledPlugin.capabilityCallsAllowed === false, "disabled plugins must fail capability checks");
check(contract.honoredContributions.navBars.emptyQueryBlocksNavigation === false, "navBars must never block the empty-query home");
check(contract.honoredContributions.provider.searchMode === "concurrent", "provider searches must be concurrent");
check(contract.honoredContributions.provider.timeoutMsPerProvider === 6000, "provider timeout contract drifted");
check(contract.honoredContributions.icons.httpSupported === false, "HTTP icons are not a supported surface");

const registry = read("src/plugins/registry.ts");
const iconSpec = read("src/launcher/iconSpec.ts");
const presenterHost = read("src/page-runtime/presenterHost.ts");
const clipboardService = read("src/page-services/clipboard/service.ts");
const navigateSearch = read("src/plugins/navigate/search.ts");
const pageRuntime = read("src/plugins/pageRuntimeMode.tsx");
const presenterBridge = read("src/page-runtime/presenterBridge.tsx");
const listTemplate = read("src/plugins/listTemplate.tsx");
const pluginFs = read("src-tauri/src/plugin_fs.rs");
const clipboard = read("src-tauri/src/clipboard.rs");
const pluginGate = read("src-tauri/src/plugins.rs");

check(registry.includes("logicLoadedIds.delete(id)"), "registry does not show the disable/unload boundary");
check(registry.includes("sanitizeProviderRows"), "registry does not budget provider results");
check(registry.includes("sanitizeNavBarContributions"), "registry does not budget navBars");
check(iconSpec.includes("/^https?:/i.test(icon)"), "icon resolver does not reject HTTP(S)");
check(presenterHost.includes("mountGeneration"), "PresenterHost has no mount generation guard");
check(clipboardService.includes("isInteractiveKeyTarget"), "clipboard Space handling does not exclude controls");
check(navigateSearch.includes("asyncGeneration"), "Navigate provider work has no local generation guard");
check(contract.pageService?.startupEventsQueued === true, "Page Service startup events must queue");
check(pageRuntime.includes("flushPendingLifecycle"), "Page Service lifecycle flush is missing");
check(contract.presenter?.passwordValuesRedacted === true, "Presenter password redaction contract drifted");
check(presenterBridge.includes("isSecretField"), "Presenter bridge does not redact password fields");
check(presenterBridge.includes("queued.splice(0)"), "Presenter bridge does not replay queued events");
check(contract.honoredContributions.provider?.drillRequiresSelect === true, "Provider drill/select contract drifted");
check(navigateSearch.includes("supportsSelect"), "Provider rows do not gate drill by select");
check(contract.honoredContributions.provider?.featureRegexWorkerTimeoutMs === 50, "Feature regex timeout drifted");
check(contract.honoredContributions.listTemplate?.usesProviderRowBudget === true, "List template budget contract drifted");
check(listTemplate.includes("sanitizeProviderRows") && listTemplate.includes("searchGeneration"), "List template generation/budget guard is missing");
check(contract.privateFiles?.canonicalPluginDirectory === true, "Private-file directory contract drifted");
check(pluginFs.includes("plugin_dir_for_id"), "Private files do not use the canonical plugin directory");
check(pluginGate.includes("MAX_FEATURES") && pluginGate.includes("MAX_REGEX_CHARS"), "Manifest fan-out/regex limits are missing");
check(contract.clipboard?.ownWriteGuard === "clipboard-sequence", "Clipboard own-write contract drifted");
check(clipboard.includes("self_write_seq") && clipboard.includes("retained_clipboard_text"), "Clipboard sequence/whitespace guard is missing");

if (failures.length) {
  for (const failure of failures) console.error(`[plugin-contract] FAIL ${failure}`);
  process.exit(1);
}
console.log(`[plugin-contract] PASS api=${contract.api}`);
