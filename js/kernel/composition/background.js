/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands. Loading it must
 * not touch a browser API: the worker calls into it once the root has something to build.
 *
 * Slices 1 to 3 build nothing here, so no shipped page or worker runs kernel code yet.
 * Slice 4 builds the worker's kernel here, with `maintainOnOpen` so startup maintenance runs
 * before anything else, hands its caller, `{surface: 'worker-internal', contextId}`, to the
 * policy port, and routes capture through it.
 */
