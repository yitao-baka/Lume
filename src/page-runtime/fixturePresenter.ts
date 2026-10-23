//! In-memory fixture Presenter used by runtime tests and CDP diagnostics. It
//! is intentionally not registered as a user-visible launcher page.

import type { PageModel, PresenterDescriptor } from "./contracts";
import { COLLECTION_SCHEMA, collectionFixture, type CollectionModel } from "./schemas";
import { PageSession } from "./session";
import type { PresenterFactory } from "./presenterHost";

export interface FixturePresenter {
  factory: PresenterFactory;
  models: PageModel[];
  disposed: () => boolean;
}

export function createFixturePresenter(label: string, fail = false): FixturePresenter {
  const models: PageModel[] = [];
  let disposed = false;
  return {
    models,
    disposed: () => disposed,
    factory: (ctx) => ({
      ready: async () => {
        if (fail) throw new Error(`${label} fixture failed`);
        models.push(ctx.model);
      },
      update: (model) => models.push(model),
      dispose: () => {
        disposed = true;
      },
    }),
  };
}

export const fixturePresenters: PresenterDescriptor[] = [
  { id: "fixture-grid", name: "Fixture grid", models: [COLLECTION_SCHEMA], builtin: true },
  { id: "fixture-list", name: "Fixture list", models: [COLLECTION_SCHEMA], builtin: true },
  { id: "fixture-other", name: "Other schema", models: ["fixture.other/v1"], builtin: true },
];

export async function runPageRuntimeFixture(): Promise<{
  session: PageSession;
  grid: FixturePresenter;
  list: FixturePresenter;
  model: PageModel;
}> {
  const model: PageModel = {
    runtime: "lume.page/v1",
    schema: COLLECTION_SCHEMA,
    revision: 1,
    status: "ready",
    data: collectionFixture as CollectionModel as never,
    selection: { primaryId: "row:1", selectedIds: ["row:1"] },
  };
  const session = new PageSession({
    pageId: "page-runtime-fixture",
    schema: COLLECTION_SCHEMA,
    presenters: fixturePresenters,
    presenterId: "fixture-grid",
  });
  await session.start({
    getModel: () => model,
    onIntent: (intent) => ({ status: "accepted", requestId: intent.requestId }),
  });
  const grid = createFixturePresenter("grid");
  const list = createFixturePresenter("list");
  await session.mount((presenter) =>
    presenter.id === "fixture-list" ? list.factory : grid.factory
  );
  await session.switchPresenter("fixture-list", () => list.factory);
  return { session, grid, list, model };
}
