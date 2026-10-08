// Fails the build when the web bundle grows past its budget. Without Metro tree shaking, Effect alone tripled it
// (3.0 MB to 9.3 MB), and nothing else would have said so.
import { readdirSync, statSync } from "node:fs";

const BUDGET = 4 * 1024 * 1024;
const dir = new URL("../apps/app/dist/_expo/static/js/web/", import.meta.url).pathname;
const [entry] = readdirSync(dir).filter((name) => name.startsWith("entry-") && name.endsWith(".js"));
if (!entry) throw new Error(`No web entry bundle in ${dir}. Run bun run build first.`);
const size = statSync(dir + entry).size;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
if (size > BUDGET) {
  console.error(`Web bundle is ${mb(size)}, over the ${mb(BUDGET)} budget. Check that tree shaking still runs.`);
  process.exit(1);
}
console.log(`Web bundle ${mb(size)} (budget ${mb(BUDGET)})`);
