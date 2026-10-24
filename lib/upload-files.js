const MAX_INLINE_UPLOAD_BYTES = 20 * 1024 * 1024;

function uploadFileError(message, statusCode = 400) {
  return Object.assign(new Error(message), {
    statusCode,
    code: statusCode === 413 ? 'upload_files_too_large' : 'invalid_upload_files',
  });
}

// Buffer's decoder accepts malformed and noncanonical base64. Validate the
// wire representation first, and bound the total before allocating any buffers.
export function normalizeUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw uploadFileError('files must be a non-empty array');
  }
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || typeof file.name !== 'string' || !file.name || file.name === '.' || file.name === '..'
      || /[\\/\p{Cc}]/u.test(file.name)
      || typeof file.mimeType !== 'string'
      || typeof file.dataBase64 !== 'string') {
      throw uploadFileError('Each file requires a basename, mimeType string and dataBase64 string');
    }
    const data = file.dataBase64;
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw uploadFileError('dataBase64 must be canonical base64');
    }
    // Check unused padding bits without decoding potentially oversized input.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if (padding && (alphabet.indexOf(data[data.length - padding - 1]) & (padding === 2 ? 15 : 3))) {
      throw uploadFileError('dataBase64 must be canonical base64');
    }
    total += data.length / 4 * 3 - padding;
    if (total > MAX_INLINE_UPLOAD_BYTES) {
      throw uploadFileError('Inline files exceed the 20MiB aggregate decoded limit', 413);
    }
  }
  return files.map(({ name, mimeType, dataBase64 }) => ({
    name, mimeType, buffer: Buffer.from(dataBase64, 'base64'),
  }));
}
