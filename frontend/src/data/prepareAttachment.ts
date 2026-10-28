// Read the selected file before networking: Android gallery providers can expose
// a File whose metadata is available but whose contents cannot be read.
export async function prepareAttachment(file: File, maxBytes = 5 * 1024 * 1024): Promise<File> {
  if (!file.size || file.size > maxBytes) throw new Error('Choose a file up to 5 MB.');
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (cause) {
    throw new Error('Could not read this file from your device. Save a copy to Downloads, then select that copy using Files.', { cause });
  }
  if (bytes.byteLength !== file.size) {
    throw new Error('The selected file could not be read completely. Save a copy to Downloads and select it again.');
  }
  // Copy actual bytes, not the provider-backed File reference. No recompression
  // or format conversion: preserve the receipt and the server's validation.
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}
