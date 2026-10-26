const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function create() {
  return {
    async search(query) {
      const q = String(query || "").trim();
      if (q === "raceparent") {
        return [{ name: "RACE_PARENT", path: "lume-probe://race-parent", drill: true }];
      }
      if (q === "racesecond") {
        return [{ name: "RACE_SECOND", path: "https://example.com/race-second" }];
      }
      if (q === "budgetprobe") {
        return [
          { name: "BAD_PATH_TYPE", path: { nested: true } },
          { name: "BAD_ICON_TYPE", path: "https://example.com/bad-icon", icon: 7 },
          ...Array.from({ length: 100 }, (_, index) => ({
            name: `BUDGET_ROW_${index}`,
            path: `https://example.com/budget/${index}`,
            description: "x".repeat(200),
          })),
        ];
      }
      if (q === "httpicon") {
        return [{
          name: "HTTP_ICON_ROW",
          path: "https://example.com/http-icon",
          icon: "http://127.0.0.1:18777/icon.png?probe=1",
        }];
      }
      return [];
    },
    async select() {
      await sleep(1200);
      return [{ name: "RACE_STALE_CHILD", path: "https://example.com/stale-child" }];
    },
    navBars() {
      return Array.from({ length: 40 }, (_, bar) => ({
        id: `flood-${bar}`,
        title: `Navbar flood ${bar}`,
        items: Array.from({ length: 50 }, (_, item) => ({
          name: `Flood item ${bar}-${item}`,
          path: `https://example.com/flood/${bar}/${item}/${"x".repeat(120)}`,
        })),
      }));
    },
  };
}
