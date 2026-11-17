const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const copyDirectory = (source, target) => {
  fs.cpSync(path.join(root, source), path.join(root, target), {
    recursive: true,
    force: true,
  });
};

const appRouterRoot = path.join(root, ".deploy", "app-router");
const appRouterResources = path.join(appRouterRoot, "resources");

fs.mkdirSync(path.join(root, "gen", "srv", "common"), { recursive: true });
copyDirectory("common", "gen/srv/common");

fs.rmSync(appRouterResources, { recursive: true, force: true });
fs.mkdirSync(appRouterRoot, { recursive: true });
copyDirectory("app", ".deploy/app-router/resources");
copyDirectory("approuter/package.json", ".deploy/app-router/package.json");
copyDirectory("approuter/xs-app.json", ".deploy/app-router/xs-app.json");

console.log("Prepared CAP common code and app-router resources for MTA deployment.");
