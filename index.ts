import { startTui } from "./tui.tsx";

const args = process.argv.slice(2);

const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 50;
const query = args.find((a) => a.startsWith("--query="))?.split("=")[1] ?? "in:inbox";

startTui({ query, limit });
