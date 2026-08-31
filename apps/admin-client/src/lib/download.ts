/**
 * Saves one canonical artifact to the browser's downloads, byte for byte.
 *
 * `artifacts.ts` in the contract gives the reason a download is never generated
 * here: the bytes are the run's own, read back out of its directory and served
 * unchanged. This function's only job is to hand the browser the same bytes
 * under the run's own suggested name, with the media type the artifact declared
 * — never `application/json` for everything, which would make a saved
 * `report.md` open as if it were data rather than the run's written report.
 */
export function downloadArtifact(filename: string, mediaType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
