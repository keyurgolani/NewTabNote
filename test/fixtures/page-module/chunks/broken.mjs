// A chunk whose static import isn't there, so its link fails with ENOENT
import { missing } from './missing.mjs';

export { missing };
