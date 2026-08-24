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
// Quality gives way before pixels do: a slide image at 0.7 is hard to
// tell from one at 0.9, while halving the pixels is visible. So the
// quality is searched first and the size only if that is not enough.
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

/**
 * Decode to a bitmap.
 *
 * createImageBitmap rather than `new Image()`: it decodes off the main
 * thread, and `imageOrientation: "from-image"` applies the EXIF rotation
 * so a photograph taken sideways on a phone is not committed sideways.
 * The old path drew the raw pixels and lost the orientation flag with
 * the rest of the metadata, which turned a correct photo into a wrong
 * one.
 */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older engines reject the options object rather than ignoring it.
    try {
      return await createImageBitmap(file);
    } catch {
      throw new Error(`${file.name} could not be read as an image`);
    }
  }
}

/**
 * Whether the image actually uses transparency.
 *
 * The format was decided from the file's MIME type: any PNG was
 * re-encoded as PNG. PNG has no quality control, so a PNG photograph or
 * screenshot could only be made smaller by throwing away pixels, and a
 * large one never reached the cap at all -- it was refused, which is why
 * uploading a screenshot did nothing.
 *
 * Most PNGs have no transparent pixel. Asking the pixels rather than the
 * container is the difference between a 4 MB refusal and a 180 KB JPEG.
 */
function usesAlpha(bitmap) {
  // A sample is enough: one transparent pixel anywhere means PNG, and a
  // thumbnail keeps every region of the image at a fraction of the cost.
  const w = Math.min(160, bitmap.width);
  const h = Math.max(1, Math.round((w / bitmap.width) * bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return true; // tainted canvas: keep transparency rather than lose it
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
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
  const bitmap = await decode(file);
  const edge = Math.max(bitmap.width, bitmap.height);
  const base = edge > TARGET_EDGE ? TARGET_EDGE / edge : 1;

  // The pixels decide, not the container.
  const alpha = usesAlpha(bitmap);
  const mime = alpha ? "image/png" : "image/jpeg";

  const encode = (scale, quality) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    // Smooth downscaling: the default is fine for small steps and visibly
    // aliased for the large ones a 4000px photograph needs.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) =>
      canvas.toBlob(resolve, mime, alpha ? undefined : quality)
    );
  };

  let blob = null;
  let last = null;

  if (!alpha) {
    // Binary search the quality rather than walking fixed steps: it
    // reaches a better answer in about six encodes instead of sixteen,
    // and sixteen re-encodes of a 4000px photograph is a frozen tab.
    let lo = 0.4;
    let hi = 0.92;
    for (let i = 0; i < 6; i += 1) {
      const mid = (lo + hi) / 2;
      const candidate = await encode(base, mid);
      if (!candidate) break;
      last = candidate;
      if (candidate.size <= MAX_BYTES) {
        blob = candidate; // good enough, and try for better
        lo = mid;
      } else {
        hi = mid;
      }
    }
    // Still over at the lowest quality worth using: fewer pixels then.
    for (const shrink of EDGE_STEPS.slice(1)) {
      if (blob) break;
      last = await encode(base * shrink, lo);
      if (last && last.size <= MAX_BYTES) blob = last;
    }
  } else {
    // PNG has no quality knob, so size is the only lever.
    for (const shrink of EDGE_STEPS) {
      last = await encode(base * shrink);
      if (last && last.size <= MAX_BYTES) {
        blob = last;
        break;
      }
    }
  }

  blob = blob ?? last;
  bitmap.close?.();
  if (!blob) throw new Error(`${file.name} could not be re-encoded`);
  if (blob.size > MAX_BYTES) {
    throw new Error(
      `${file.name} is still ${Math.round(blob.size / 1024)} KB after ` +
        `compression, over the ${MAX_BYTES / 1000} KB the build allows. ` +
        (alpha
          ? "It has transparent areas, so it has to stay a PNG. Flatten it " +
            "onto a background and it will compress as a photograph."
          : "Crop it, or simplify it, and try again.")
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
