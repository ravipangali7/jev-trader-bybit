import { config } from "./config.ts";
import { PaperStore } from "./store.ts";

const path = config.paperDb;
const store = new PaperStore(path);
store.reset();
store.close();
console.log(`paper account reset (${path})`);
