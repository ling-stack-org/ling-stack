import { resolve } from "node:path";
import process from "node:process";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

export { ts };

export function withTypeScriptSourceFiles(files, callback, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const configFile = options.configFile ?? resolve(cwd, "tsconfig.json");
  const sourcePaths = [...new Set(files.map((file) => resolve(file)))];
  const api = new API({ cwd });
  const snapshot = api.updateSnapshot({
    openProjects: [configFile],
    openFiles: sourcePaths,
  });
  try {
    const sourceFiles = new Map(sourcePaths.map((file) => {
      const project = snapshot.getDefaultProjectForFile(file) ?? snapshot.getProject(configFile);
      const sourceFile = project?.program.getSourceFile(file);
      if (!sourceFile) {
        throw new Error(`TypeScript 7 could not load source file: ${file}`);
      }
      return [file, sourceFile];
    }));
    return callback(sourceFiles);
  } finally {
    snapshot.dispose();
    api.close();
  }
}

export function visitTypeScriptNode(node, callback) {
  callback(node);
  ts.visitEachChild(node, (child) => {
    visitTypeScriptNode(child, callback);
    return child;
  });
}
