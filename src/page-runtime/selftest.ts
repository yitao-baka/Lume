//! Browser-independent unit checks for the Page Runtime foundation. The
//! launcher does not import this module; scripts/page_runtime_unit_test.mjs
//! loads it through Vite SSR.

import type { PageIntent, PageModel } from "./contracts";
import { validateIntent } from "./intents";
import { normalizeLayoutReport, normalizeResizeRequest } from "./layout";
import { PageModelStore, validatePageModel } from "./modelStore";
import { selectCompatiblePresenter } from "./presenterHost";
import { resolveResource } from "./resources";
import { COLLECTION_SCHEMA, collectionFixture, type CollectionModel } from "./schemas";
import { PageSession } from "./session";
import { PresenterHost } from "./presenterHost";
import { createFixturePresenter, fixturePresenters } from "./fixturePresenter";
import { isTranslationData } from "./translatorDemo";
import translationFixture from "./fixtures/translator-translation.v1.json";
import { capSnapshot } from "../plugins/iframeBridge";
import {
  NAV_BAR_LIMITS,
  PROVIDER_ROW_LIMITS,
  fitNavBarPageBudget,
  sanitizeNavBarContributions,
  sanitizeProviderRows,
} from "../plugins/contributionBudget";

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function expectThrows(run: () => void, contains: string): void {
  try {
    run();
  } catch (err) {
    const message = String(err);
    expect(message.includes(contains), `expected "${contains}" in "${message}"`);
    return;
  }
  throw new Error(`expected throw containing "${contains}"`);
}

function model(revision: number, data: unknown = collectionFixture): PageModel {
  return {
    runtime: "lume.page/v1",
    schema: COLLECTION_SCHEMA,
    revision,
    status: "ready",
    data: data as never,
  };
}

export function runPageRuntimeSelfTests(): string[] {
  const passed: string[] = [];
  const store = new PageModelStore("selftest-store", {
    schedule: () => 1,
    cancel: () => {},
  });
  store.publish(model(1));
  store.publish(model(2));
  store.publish(model(1));
  expect(store.get()?.revision === 2, "stale revision must not overwrite");
  passed.push("model revision monotonicity");

  const scheduled: (() => void)[] = [];
  const coalesced = new PageModelStore("coalesced", {
    schedule: (flush) => { scheduled.push(flush); return scheduled.length; },
    cancel: () => {},
  });
  const seen: number[] = [];
  coalesced.subscribe((next) => seen.push(next.revision));
  coalesced.publish(model(1));
  coalesced.publish(model(2));
  expect(seen.length === 0, "updates must wait for the animation-frame boundary");
  scheduled[0]();
  expect(seen.length === 1 && seen[0] === 2, "high-frequency updates must coalesce to the latest model");
  passed.push("model update frame coalescing");

  expectThrows(() => validatePageModel(model(1, { fn: () => 1 })), "unsupported function");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectThrows(() => validatePageModel(model(1, cyclic)), "cyclic value");
  expectThrows(() => validatePageModel(model(1, { text: "x".repeat(800) }), 400), "exceeds");
  passed.push("model JSON and size validation");

  expectThrows(
    () => validatePageModel(model(1, { icon: { kind: "thumbnail", src: "javascript:alert(1)" } })),
    "scheme refused"
  );
  const resource = resolveResource(
    { kind: "url", src: "asset://icons/a.svg", light: "data:image/svg+xml;base64,PHN2Zy8+", dark: "asset://icons/a-dark.svg" },
    "dark"
  );
  expect(resource.src === "asset://icons/a-dark.svg", "dark resource variant");
  expect(
    (() => {
      validatePageModel(model(1, {
        icon: { kind: "thumbnail", src: "data:image/png;base64," + "A".repeat(12_000) },
      }));
      return true;
    })(),
    "large inline image thumbnails must pass the resource length guard"
  );
  expect(
    (() => {
      validatePageModel(model(1, {
        icon: { kind: "url", src: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E" },
      }));
      return true;
    })(),
    "UTF-8 SVG data URLs used by navBars must pass the resource whitelist"
  );
  passed.push("resource scheme whitelist and selection");

  const intentModel = model(1, {
    items: [{ id: "item-1", label: "One", actions: ["open"] }],
  });
  expect(
    validateIntent({ type: "item.action", targetId: "item-1", actionId: "open" }, intentModel) === null,
    "declared action must pass"
  );
  expect(
    validateIntent({ type: "item.action", targetId: "item-1", actionId: "delete" }, intentModel)?.status === "failed",
    "undeclared action must fail"
  );
  expect(
    validateIntent({ type: "item.activate", targetId: "ghost" }, intentModel)?.status === "failed",
    "unknown target must fail"
  );
  expect(
    validateIntent({ type: "viewport.request", payload: { offset: 0, limit: 5001 } }, intentModel)?.status === "failed",
    "oversized viewport must fail"
  );
  expect(
    validateIntent({ type: "viewport.request", payload: { offset: 40, limit: 40 } }, intentModel) === null,
    "valid collection window must pass"
  );
  passed.push("intent target/action and collection window validation");

  expect(
    selectCompatiblePresenter(fixturePresenters, COLLECTION_SCHEMA, "missing")?.id === "fixture-grid",
    "incompatible request must fall back"
  );
  expect(
    selectCompatiblePresenter(fixturePresenters, "fixture.other/v1", "fixture-grid")?.id === "fixture-other",
    "schema compatibility must be enforced"
  );
  passed.push("Presenter compatibility fallback");

  expect(isTranslationData(translationFixture.data), "translation fixture must pass the custom schema guard");
  passed.push("custom translation schema guard");

  const legacy = { pageRuntime: { revision: 7 } };
  expect(
    JSON.stringify(capSnapshot(legacy)) === JSON.stringify(legacy),
    "legacy snapshots must survive the cap unchanged"
  );
  const capped = capSnapshot({
    v: 2,
    auto: { fields: [{ key: "id:q", value: "ok", checked: false }] },
    custom: { blob: "x".repeat(600_000) },
  }) as { auto?: { fields?: unknown[] }; custom?: unknown } | null;
  expect(capped?.auto?.fields?.length === 1 && capped.custom === null, "oversized custom snapshot layer must drop");
  const huge = capSnapshot({
    v: 2,
    auto: {
      fields: Array.from({ length: 200 }, (_, i) => ({
        key: `path:field-${i}`,
        value: "x".repeat(10_000),
        checked: false,
      })),
    },
    custom: null,
  });
  expect(huge === null || JSON.stringify(huge).length <= 1_000_000, "snapshot total must stay capped");
  const secret = capSnapshot({
    v: 2,
    auto: { fields: [{ key: "id:api-key", value: "sk-live-secret", checked: true, secret: true }] },
    custom: null,
  }) as { auto?: { fields?: { value?: unknown; checked?: boolean }[] } } | null;
  expect(secret?.auto?.fields?.[0]?.value === "", "password fields must never enter auto snapshots");
  expect(secret?.auto?.fields?.[0]?.checked === true, "password checked state remains restorable");
  passed.push("snapshot layer and total-size caps with password redaction");

  expect(
    normalizeLayoutReport({ sizing: "fit", contentHeight: 320, expanded: false }).contentHeight === 320,
    "Presenter fit height must survive validation"
  );
  expectThrows(() => normalizeLayoutReport({ sizing: "fit", contentHeight: Number.NaN }), "finite");
  expectThrows(() => normalizeLayoutReport({ sizing: "fixed", height: 20_000 }), "between");
  expectThrows(() => normalizeResizeRequest(Number.NaN, 320), "finite");
  expect(normalizeResizeRequest(900, 320).width === 900, "valid resize axes survive validation");
  passed.push("Presenter layout validation and fit height");
  const providerBudget = sanitizeProviderRows([
    { name: "ok", path: "https://example.com/ok" },
    { name: "bad path", path: { nested: true } },
    { name: "bad icon", path: "https://example.com/icon", icon: 7 },
    { name: "bad number", path: "https://example.com/nan", score: Number.POSITIVE_INFINITY },
    ...Array.from({ length: 100 }, (_, i) => ({ name: `row-${i}`, path: `https://example.com/${i}` })),
  ]);
  expect(
    providerBudget.value.length <= PROVIDER_ROW_LIMITS.maxRows,
    "provider rows must obey the row-count budget"
  );
  expect(providerBudget.droppedRows === 3, "malformed provider rows are dropped");
  expect(
    !providerBudget.value.some((row) => ["bad path", "bad icon", "bad number"].includes(row.name)),
    "malformed provider rows never reach the grid"
  );

  const navBudget = sanitizeNavBarContributions(
    "budget-probe",
    Array.from({ length: 40 }, (_, bar) => ({
      id: `bar-${bar}`,
      title: `Bar ${bar}`,
      items: Array.from({ length: 50 }, (_, item) => ({
        name: `Item ${bar}-${item}`,
        path: `https://example.com/${bar}/${item}/${"x".repeat(120)}`,
      })),
    })),
    () => undefined
  );
  expect(navBudget.value.length <= NAV_BAR_LIMITS.maxBarsPerPlugin, "navBars bar budget applies");
  expect(
    navBudget.value.reduce((sum, bar) => sum + bar.items.length, 0) <= NAV_BAR_LIMITS.maxItemsPerPlugin,
    "navBars item budget applies"
  );
  expect(navBudget.truncated, "oversized navBars are reported as truncated");

  const duplicate = sanitizeNavBarContributions(
    "duplicate-probe",
    [
      { id: "same", title: "First", items: [{ name: "One", path: "https://example.com/one" }] },
      { id: "same", title: "Second", items: [{ name: "Two", path: "https://example.com/two" }] },
    ],
    () => undefined
  );
  expect(duplicate.value.length === 1 && duplicate.value[0].title === "First", "duplicate plugin bar ids keep only the first");
  expect(duplicate.droppedRows === 1 && duplicate.truncated, "duplicate plugin bar ids are diagnosed as dropped");

  const duplicatePageBars = [
    { id: "p:same", title: "First", items: [{ name: "One", path: "https://example.com/one" }] },
    { id: "p:same", title: "Second", items: [{ name: "Two", path: "https://example.com/two" }] },
  ];
  const duplicatePage = fitNavBarPageBudget(duplicatePageBars);
  expect(duplicatePage.value.length === 1 && duplicatePage.value[0].title === "First", "page budget drops duplicate zone keys");
  expect(duplicatePage.droppedRows === 1, "page budget reports duplicate zone keys");

  const pageBars = Array.from({ length: 40 }, (_, i) => ({
    id: `p:${i}`,
    title: `Page bar ${i}`,
    items: Array.from({ length: 20 }, (_, j) => ({
      name: `Page item ${i}-${j}`,
      path: `https://example.com/page/${i}/${j}`,
    })),
  }));
  const pageBudget = fitNavBarPageBudget(pageBars);
  expect(pageBudget.value.length <= NAV_BAR_LIMITS.maxPageBars, "page-level nav bar budget applies");
  expect(
    pageBudget.value.reduce((sum, bar) => sum + bar.items.length, 0) <= NAV_BAR_LIMITS.maxPageItems,
    "page-level nav item budget applies"
  );
  passed.push("plugin contribution budgets are bounded and reported");

  return passed;
}

export async function runPageRuntimeAsyncSelfTests(): Promise<string[]> {
  const passed: string[] = [];
  const guarded = new PageSession({
    pageId: "selftest-invalid-model",
    schema: COLLECTION_SCHEMA,
    presenters: fixturePresenters,
    modelStore: { schedule: () => 1, cancel: () => {} },
  });
  const rejected = guarded.publish(model(1, { fn: () => 1 }));
  expect(
    rejected.status === "error" && rejected.error?.code === "model.invalid" && guarded.store.get()?.status === "error",
    "oversized or malformed snapshots must publish a visible page error"
  );
  await guarded.dispose();
  passed.push("invalid Page Model becomes a visible page error");

  const initial = model(1, collectionFixture as CollectionModel as never);
  const session = new PageSession({
    pageId: "selftest-session",
    schema: COLLECTION_SCHEMA,
    presenters: fixturePresenters,
    presenterId: "fixture-grid",
    modelStore: { schedule: () => 1, cancel: () => {} },
  });
  let intents = 0;
  await session.start({
    getModel: () => initial,
    onIntent: (intent) => {
      intents++;
      return { status: "accepted", requestId: intent.requestId };
    },
  });
  const grid = createFixturePresenter("grid");
  const first = await session.mount(() => grid.factory);
  expect(first.status === "ready", "fixture Presenter must become ready");
  expect(grid.models[0]?.revision === 1, "fixture Presenter receives the initial model");
  await session.dispatch({
    type: "item.action",
    targetId: "row:1",
    actionId: "open",
  });
  expect(intents === 1, "valid intent reaches the Page Service");
  await session.show();
  expect(session.snapshot().visible === true, "Page Session records the visible lifecycle state");
  await session.hide();
  expect(session.snapshot().visible === false, "Page Session records the hidden lifecycle state");
  passed.push("fixture Presenter ready, visibility state and intent routing");

  const before = session.store.get();
  const list = createFixturePresenter("list");
  const switched = await session.switchPresenter("fixture-list", () => list.factory);
  expect(switched.status === "ready" && list.models[0]?.revision === before?.revision, "Presenter switch keeps model");
  expect(grid.disposed(), "old Presenter is disposed after switch");
  expect(session.store.get() === before, "Presenter switch does not rebuild the model store");
  passed.push("Presenter switch preserves model and selection");

  const modelBeforeFailure = session.store.get();
  const quietHost = new PresenterHost("selftest-session", { logErrors: false });
  const failed = await quietHost.mount({
    pageId: session.pageId,
    presenters: fixturePresenters,
    requestedId: "fixture-grid",
    schema: COLLECTION_SCHEMA,
    store: session.store,
    dispatch: (intent) => session.dispatch(intent),
    factory: (presenter) => createFixturePresenter(presenter.id, true).factory,
  });
  expect(failed.status === "error", "repeated Presenter failures end in an error state");
  expect(session.store.get() === modelBeforeFailure, "Presenter failure keeps the authoritative model");
  const recovered = await session.switchPresenter("fixture-list", () => createFixturePresenter("recovery").factory);
  expect(recovered.status === "ready", "session can remount a Presenter after failure");
  passed.push("Presenter crash isolation and remount");

  let disposedFailures = 0;
  const leakingHost = new PresenterHost("selftest-leak", { logErrors: false });
  const failedReady = await leakingHost.mount({
    pageId: "selftest-leak",
    presenters: [fixturePresenters[0]],
    schema: COLLECTION_SCHEMA,
    store: session.store,
    dispatch: (intent) => session.dispatch(intent),
    factory: () => () => ({
      ready: () => {
        throw new Error("ready rejected");
      },
      dispose: () => {
        disposedFailures += 1;
      },
    }),
  });
  expect(failedReady.status === "error" && disposedFailures === 2, "failed ready handles must be disposed");
  passed.push("Presenter ready-failure cleanup");

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const raceHost = new PresenterHost("selftest-presenter-race", { logErrors: false });
  let slowDisposed = false;
  const raceRequest = {
    pageId: "selftest-presenter-race",
    presenters: [
      { id: "slow-a", name: "Slow", models: [COLLECTION_SCHEMA], builtin: true },
      { id: "fast-b", name: "Fast", models: [COLLECTION_SCHEMA], builtin: true },
    ],
    schema: COLLECTION_SCHEMA,
    store: session.store,
    dispatch: (intent: PageIntent) => session.dispatch(intent),
  };
  const slowMount = raceHost.mount({
    ...raceRequest,
    requestedId: "slow-a",
    factory: () => () => ({
      ready: async () => { await sleep(120); },
      dispose: () => { slowDisposed = true; },
    }),
  });
  await sleep(5);
  const fastMount = raceHost.mount({
    ...raceRequest,
    requestedId: "fast-b",
    factory: () => () => ({
      ready: async () => { await sleep(15); },
      dispose: () => {},
    }),
  });
  await Promise.all([slowMount, fastMount]);
  expect(raceHost.getState().presenterId === "fast-b", "latest Presenter wins a concurrent mount");
  expect(raceHost.getState().status === "ready", "latest Presenter remains ready");
  expect(raceHost.getPresenter()?.id === "fast-b", "current handle matches reported Presenter");
  expect(slowDisposed, "superseded Presenter handle is disposed");
  raceHost.dispose();
  passed.push("Presenter mount generations cancel stale ready handshakes");

  const chromeHost = new PresenterHost("selftest-presenter-chrome", { logErrors: false });
  const chromePresenters = [
    { id: "chrome-a", name: "A", models: [COLLECTION_SCHEMA], builtin: true },
    { id: "chrome-b", name: "B", models: [COLLECTION_SCHEMA], builtin: true },
  ];
  await chromeHost.mount({
    pageId: "selftest-presenter-chrome",
    presenters: chromePresenters,
    requestedId: "chrome-a",
    schema: COLLECTION_SCHEMA,
    store: session.store,
    dispatch: (intent) => session.dispatch(intent),
    factory: () => (context) => {
      context.reportLayout({ sizing: "fixed", height: 555 });
      context.setModal(true);
      return { dispose: () => {} };
    },
  });
  expect(chromeHost.getState().modal && chromeHost.getState().layout?.height === 555, "Presenter A owns modal/layout");
  await chromeHost.mount({
    pageId: "selftest-presenter-chrome",
    presenters: chromePresenters,
    requestedId: "chrome-b",
    schema: COLLECTION_SCHEMA,
    store: session.store,
    dispatch: (intent) => session.dispatch(intent),
    factory: () => () => ({ dispose: () => {} }),
  });
  expect(!chromeHost.getState().modal && chromeHost.getState().layout === null, "Presenter switch resets modal/layout");
  chromeHost.dispose();
  passed.push("Presenter switch resets transient chrome state");

  await session.dispose();
  let destroyedMountRejected = false;
  try {
    await session.mount(() => createFixturePresenter("destroyed").factory);
  } catch (err) {
    destroyedMountRejected = String(err).includes("destroyed");
  }
  expect(destroyedMountRejected, "destroyed Page Session refuses a late mount");
  passed.push("destroyed Page Session cannot remount");
  return passed;
}
