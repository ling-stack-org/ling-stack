import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { retainPackagedSkillGeneration } from "../../packages/daemon/dist/features/skills/packaged-history.js";

const [work, phase, selectionFile] = process.argv.slice(2);
const probe = await open(join(work, "handle-probe"), "wx");
const prototype = Object.getPrototypeOf(probe), write = prototype.writeFile, stat = prototype.stat;
await probe.close();
let writer;
const pause = async () => { setInterval(() => {}, 1000); process.send({ phase }); await new Promise(() => {}); };
prototype.writeFile = async function(data, ...args) {
  const result = await write.call(this, data, ...args);
  if (typeof data === "string" && data.includes('"token":') && data.includes(`"pid":${process.pid}`)) {
    writer = this;
    if (phase === "after-lock") await pause();
  }
  return result;
};
prototype.stat = async function(...args) {
  if (this === writer && phase === "after-publication") await pause();
  return stat.apply(this, args);
};
await retainPackagedSkillGeneration(join(work, "cache"), JSON.parse(await readFile(selectionFile)));
throw new Error("interruption probe did not reach its checkpoint");
