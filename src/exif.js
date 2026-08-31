// Minimal, dependency-free EXIF reader - extracts just the photo's actual
// capture timestamp (DateTimeOriginal), which is what lets a photo be
// matched to the nearest point on a timestamped route. No image library
// needed for this one field; JPEG's EXIF structure is simple enough to
// read directly from the file's own bytes.

const DATETIME_ORIGINAL_TAG = 0x9003;

export async function readPhotoCaptureTime(file) {
  try {
    const buf = await file.slice(0, 128 * 1024).arrayBuffer(); // EXIF sits near the file start
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xffd8) return null; // not a JPEG

    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if (marker === 0xffe1) {
        return parseExifSegment(view, offset + 4);
      }
      if ((marker & 0xff00) !== 0xff00) break; // not a valid marker, stop
      const size = view.getUint16(offset + 2);
      offset += 2 + size;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function parseExifSegment(view, start) {
  // Expect "Exif\0\0" then a TIFF header
  if (view.getUint32(start) !== 0x45786966) return null; // "Exif"
  const tiffStart = start + 6;
  const little = view.getUint16(tiffStart) === 0x4949;
  const getU16 = (o) => view.getUint16(o, little);
  const getU32 = (o) => view.getUint32(o, little);

  if (getU16(tiffStart + 2) !== 0x002a) return null; // TIFF magic
  const ifd0Offset = tiffStart + getU32(tiffStart + 4);

  const exifIfdOffset = findTag(view, tiffStart, ifd0Offset, 0x8769, getU16, getU32, little);
  if (exifIfdOffset == null) return null;

  const dateOffset = findTag(view, tiffStart, tiffStart + exifIfdOffset, DATETIME_ORIGINAL_TAG, getU16, getU32, little, true);
  if (dateOffset == null) return null;

  // DateTimeOriginal is an ASCII string "YYYY:MM:DD HH:MM:SS\0" (20 bytes)
  let str = '';
  for (let i = 0; i < 19; i++) str += String.fromCharCode(view.getUint8(dateOffset + i));
  const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
}

// Walks one IFD looking for a tag. For pointer-type tags (e.g. the Exif
// sub-IFD offset) returns the raw value; for the date tag, returns the
// absolute file offset of its string data (values <=4 bytes are stored
// inline, but this string is longer, so it's always an offset).
function findTag(view, tiffStart, ifdOffset, targetTag, getU16, getU32, little, wantAbsoluteOffset) {
  const count = getU16(ifdOffset);
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = getU16(entryOffset);
    if (tag !== targetTag) continue;
    const valueOffset = entryOffset + 8;
    if (wantAbsoluteOffset) {
      return tiffStart + getU32(valueOffset);
    }
    return getU32(valueOffset);
  }
  return null;
}
