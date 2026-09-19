import { registerPluginUpdater } from "./plugin-updater.js";
import { registerSessionPathRoute } from "./session-path.js";
const inject = ["webServer"];
function apply(ctx) {
  const disposers = [];
  try {
    disposers.push(registerPluginUpdater(ctx, {
      endpoint: "/api/dsh-archive-manager-pro/update",
      packageName: "dsh-archive-manager-pro",
      manifestUrl: new URL("../package.json", import.meta.url)
    }));
  } catch (error) {
    ctx.logger?.warn?.(`archive-manager-plus: updater disabled: ${String(error)}`);
  }
  try {
    disposers.push(registerSessionPathRoute(ctx));
  } catch (error) {
    ctx.logger?.warn?.(`archive-manager-plus: session-path route disabled: ${String(error)}`);
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch (error) { /* noop */ }
    }
  };
}
export {
  apply,
  inject
};
