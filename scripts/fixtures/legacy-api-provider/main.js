export default function create() {
  return {
    search() {
      return [{ name: "API1-PROVIDER-LOADED", path: "legacy-api-provider-marker" }];
    },
  };
}
