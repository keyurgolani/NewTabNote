// A chunk that imports lazy.mjs statically, so its load runs lazy.mjs, top-level awaits and all,
// while an import() of lazy.mjs itself may be waiting on that run
import { answer } from './lazy.mjs';

export { answer };
