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

// 2000px on the long edge, which is what the template actually needs:
// its widest placeholder is 90% of a slide, so 1728px fills it on a
// 1080p projector. The rest is headroom for a crop.
const TARGET_EDGE = 2000;
// Matches assets.MAX_IMAGE_BYTES. The build refuses anything larger, so
// an upload that ignored it would commit a file and fail CI afterwards.
const MAX_BYTES = 500_000;
const JPEG_QUALITY = 0.82;
// Quality steps, then size steps. Detail costs more than pixels do, so
// quality gives way first: a slide image at 0.7 is hard to tell from one
// at 0.82, while halving the pixels is visible.
const QUALITY_STEPS = [0.82, 0.74, 0.66, 0.58];
const EDGE_STEPS = [1, 0.8, 0.64];
// WebP is deliberately absent, and not for want of trying: python-pptx
// refuses it outright -- "unsupported image format, expected one of
// BMP, GIF, JPEG, PNG, TIFF, WMF" -- so a WebP on a slide fails the
// build. It would save about a fifth at these sizes, which is not worth
// a deck that cannot be produced.
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
  const base = edge > TARGET_EDGE ? TARGET_EDGE / edge : 1;

  // PNG keeps transparency; anything else is a photo and takes JPEG.
  const alpha = /png|gif|webp/i.test(file.type);
  const mime = alpha ? "image/png" : "image/jpeg";

  const encode = (scale, quality) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) =>
      canvas.toBlob(resolve, mime, alpha ? undefined : quality)
    );
  };

  // Under the cap, or as close as the steps get. Without this an upload
  // could commit a file the build then refuses -- which is a failure
  // after the fact, and the worst moment to discover a size limit.
  let blob = null;
  let last = null;
  for (const shrink of EDGE_STEPS) {
    for (const quality of alpha ? [undefined] : QUALITY_STEPS) {
      last = await encode(base * shrink, quality ?? JPEG_QUALITY);
      if (!last) continue;
      if (last.size <= MAX_BYTES) {
        blob = last;
        break;
      }
    }
    if (blob) break;
  }
  blob = blob ?? last;
  if (!blob) throw new Error(`${file.name} could not be re-encoded`);
  if (blob.size > MAX_BYTES) {
    throw new Error(
      `${file.name} is still ${Math.round(blob.size / 1024)} KB after ` +
        `compression, over the ${MAX_BYTES / 1000} KB the build allows. ` +
        "Crop it, or simplify it, and try again."
    );
  }

  const stem = safeName(file.name).replace(/\.[^.]+$/, "");
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    name: `${stem}.${alpha ? "png" : "jpg"}`,
    bytesIn: file.size,
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
