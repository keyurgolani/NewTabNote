# Vendored Libraries

Third-party libraries bundled in `js/lib/`. These are copied to `dist/js/lib/` during the build without modification.

| File              | Library              | Version | Source                                                                                                           | Purpose                                                  |
| ----------------- | -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `chart.js`        | Chart.js             | 4.4.1   | https://www.chartjs.org / [jsDelivr](https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js)              | Analytics dashboard charts                               |
| `fuse.js`         | Fuse.js              | 7.1.0   | https://fusejs.io / [npm](https://www.npmjs.com/package/fuse.js/v/7.1.0)                                         | Lightweight fuzzy search for sidebar and command palette |
| `jszip.min.js`    | JSZip                | 3.10.1  | https://stuk.github.io/jszip / [npm](https://www.npmjs.com/package/jszip/v/3.10.1)                               | ZIP archive generation for bulk export                   |
| `transformers.js` | @xenova/transformers | 2.17.1  | https://huggingface.co/docs/transformers.js / [npm](https://www.npmjs.com/package/@xenova/transformers/v/2.17.1) | Local embedding generation for semantic search           |
