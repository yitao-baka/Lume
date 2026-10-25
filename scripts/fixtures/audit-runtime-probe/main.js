export default function create(ctx) {
  return {
    async search(query) {
      const q = String(query || "").trim();
      if (q === "auditlong") {
        return [{
          name: "AUDIT_LONG_TARGET",
          path: "https://example.com/" + "x".repeat(300),
          enter: true,
        }];
      }
      if (q === "auditrole") {
        return [{
          name: `AUDIT_ROLE page:${typeof ctx.page} secrets:${typeof ctx.secrets}`,
          path: "https://example.com/role",
        }];
      }
      if (q === "auditperm") {
        try {
          const text = await ctx.clipboard.readText();
          return [{ name: `AUDIT_PERM ALLOWED:${String(text)}`, path: "https://example.com/perm" }];
        } catch {
          return [{ name: "AUDIT_PERM DENIED", path: "https://example.com/perm" }];
        }
      }
      return [];
    },
    onEnter() {
      ctx.app.toast("AUDIT_LONG_ENTER");
    },
  };
}
