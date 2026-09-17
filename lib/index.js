import { registerPluginUpdater } from "./plugin-updater.js";
const inject = ["webServer"];
function apply(ctx) {
  return registerPluginUpdater(ctx, {
    endpoint: "/api/dsh-archive-manager-plus/update",
    packageName: "dsh-archive-manager-plus",
    manifestUrl: new URL("../package.json", import.meta.url)
  });
}
export {
  apply,
  inject
};
