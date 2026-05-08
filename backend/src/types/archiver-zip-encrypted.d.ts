// Minimal type stub for archiver-zip-encrypted (no upstream @types).
// The package exports a ZIP-encrypted format implementation that
// archiver registers via `archiver.registerFormat('zip-encrypted', x)`.
// We treat the default export as opaque since archiver only forwards
// it to its plugin registry.
declare module 'archiver-zip-encrypted' {
  const archiverZipEncrypted: unknown;
  export default archiverZipEncrypted;
}
