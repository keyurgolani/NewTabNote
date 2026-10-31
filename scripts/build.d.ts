// What scripts/build.js exports, so the strict build code (tsconfig.strict.json) can read its
// lists without checking the legacy script itself (#27, "Type gate").

export const JS_FILES: string[];
export const JS_DIRS: string[];
export const CSS_FILES: string[];
export const HTML_FILES: string[];
export const STATIC_FILES: string[];
export const STATIC_DIRS: string[];
export const BUILD_INPUTS: string[];
export const COPY_AS_IS: string[];
export const CSS_LEVEL_1: string[];
export const MINIMUM_CHROME_VERSION: number;
