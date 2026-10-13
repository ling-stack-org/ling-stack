import { app } from "electron";
import { initializeDesktopQaLaunchProfile, readDesktopLaunchPackageMetadata } from "./qa-launch-profile.js";

// No static Ling runtime imports: scope and environment must be fixed before Main's dependency graph evaluates.
const scope = initializeDesktopQaLaunchProfile({
  argv: process.argv,
  environment: process.env,
  packaged: app.isPackaged,
  packageMetadata: app.isPackaged ? readDesktopLaunchPackageMetadata(app.getAppPath()) : undefined,
  applicationPath: app.getAppPath(),
  userId: process.getuid?.(),
  getUserDataPath: () => app.getPath("userData"),
  setUserDataPath: path => app.setPath("userData", path),
});
if (scope) console.info(JSON.stringify({ event: "desktop.owned_synthetic_qa_profile", ...scope }));

await import("./main.js");
