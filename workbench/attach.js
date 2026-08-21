// Files carried with a block: images, spreadsheets, PDFs.
//
// Two destinations, and the split is deliberate:
//
//   media/  images, which go through the asset policy — resized to
//           2000 px, re-encoded, and stripped of every scrap of
//           metadata. Clinical photographs must not carry GPS
//           coordinates or device identifiers into a public repo, and
//           that is not a preference.
//   files/  everything else, byte for byte. Running an image policy
//           over a spreadsheet would corrupt it, and one folder holding
//           both makes it ambiguous which rule applies.
//
// This mirrors scripts/prepare_image.py so the browser and the CI gate
// agree. It runs before the bytes ever reach a commit.

const TARGET_EDGE = 2000;
const JPEG_QUALITY = 0.82;
const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|bmp)$/i;

/** A repo-safe file name: no spaces, no surprises, extension kept. */
export function safeName(name) {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const ext = (dot > 0 ? name.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext ? `${stem || "file"}.${ext}` : stem || "file";
}

function readAsImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} could not be read as an image`));
    };
    img.src = url;
  });
}

/**
 * An image, resized and stripped. Returns {bytes, name}.
 *
 * Drawing to a canvas and re-encoding is what removes the metadata:
 * the canvas holds pixels and nothing else, so EXIF cannot survive it.
 * That is the whole mechanism, and it is why this cannot be skipped for
 * a file that "looks small enough".
 */
export async function prepareImage(file) {
  const img = await readAsImage(file);
  const edge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = edge > TARGET_EDGE ? TARGET_EDGE / edge : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // PNG keeps transparency; anything else is a photo and takes JPEG.
  const alpha = /png|gif|webp/i.test(file.type);
  const mime = alpha ? "image/png" : "image/jpeg";
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, mime, alpha ? undefined : JPEG_QUALITY)
  );
  if (!blob) throw new Error(`${file.name} could not be re-encoded`);

  const stem = safeName(file.name).replace(/\.[^.]+$/, "");
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    name: `${stem}.${alpha ? "png" : "jpg"}`,
  };
}

/**
 * A file ready to commit: {bytes, name, dir, isImage}.
 * `dir` is "media" or "files" — the caller joins it to the block.
 */
export async function prepareUpload(file) {
  if (IMAGE_TYPES.test(file.type)) {
    const { bytes, name } = await prepareImage(file);
    return { bytes, name, dir: "media", isImage: true };
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: safeName(file.name),
    dir: "files",
    isImage: false,
  };
}

/** The markdown that links a prepared upload from a document. */
export function linkFor({ name, dir, isImage }, title) {
  const path = `${dir}/${name}`;
  return isImage ? `![${title || name}](${path})` : `[${title || name}](${path})`;
}

/** Bytes to base64, for the Git blob API, without blowing the stack. */
export function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000; // apply() over a whole file overflows the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
