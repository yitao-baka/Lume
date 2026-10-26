export default function create(ctx) {
  const bump = async (key) => {
    const current = Number(await ctx.storage.get(key)) || 0;
    await ctx.storage.set(key, current + 1);
  };
  return {
    async onShow() {
      await bump("showCount");
    },
    async onQuery(query) {
      await ctx.storage.set("lastQuery", String(query));
      await bump("queryCount");
      try {
        const text = await ctx.clipboard.readText();
        await ctx.storage.set("clipboardOk", true);
        await ctx.storage.set("clipboardAfterQuery", text);
      } catch (error) {
        await ctx.storage.set("clipboardOk", false);
        await ctx.storage.set("clipboardError", String(error));
      }
    },
  };
}
