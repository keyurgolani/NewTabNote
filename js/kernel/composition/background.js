/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands. Loading it must
 * not touch a browser API: the worker calls into it once the root has something to build.
 *
 * Slice 1 is the module seam only, so this stub builds nothing yet. Slice 3 builds the
 * worker's kernel here and hands its caller, `{surface, contextId}`, to the policy port;
 * slice 4 routes capture through it.
 */
