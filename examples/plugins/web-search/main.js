// Lume provider plugin — the default export must be
// { search(query): Promise<{ name, path }[]> }.
// Results render in the search grid after the native index results;
// activating one runs it through launch_app (files and URLs both work).
export default {
  async search(query) {
    const q = query.trim();
    if (!q) return [];
    return [
      {
        name: `搜索 "${q}"`,
        path: `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
      },
    ];
  },
};
