// Wrangler bundles .txt imports as strings (the "Text" rule in wrangler.jsonc).
declare module '*.txt' { const text: string; export default text; }
