// Pictures and video on a slide.
//
// Three ways one gets there, and they are genuinely different things:
//
//   **Uploaded** — bytes from the author's machine, put through the
//   asset policy before they ever reach a commit, and written into the
//   session's `media/`.
//
//   **Reused** — already in the repo. A course uses the same diagram in
//   four sessions and should not carry four copies of it.
//
//   **Linked** — a URL. Video is always this: it is hosted elsewhere and
//   the repo carries a poster, never the file.
//
// All three end up in a placeholder the template defines. A slide cannot
// put a picture anywhere it likes, because the template owns the layout —
// which is the whole reason this pipeline exists.

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Every image already in the repo, newest-looking first. */
export function repoImages(paths) {
  return (paths || [])
    .filter((p) => IMAGE.test(p))
    .filter((p) => !p.startsWith("branding/"))
    .sort();
}

/**
 * Where a browser can actually load `src` from.
 *
 * A pending upload is bytes in memory and has no URL until one is made
 * for it. Everything else is read straight from the repo, the same way
 * every other file is.
 */
export function resolveMedia(src, { blockId, repo, uploads, urls }) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;

  // Relative to the block, which is how a slide refers to its own media.
  const path = src.startsWith("blocks/") ? src : `blocks/${blockId}/${src}`;

  const pending = uploads?.get(path);
  if (pending) {
    // Made once and kept: a fresh object URL on every render would leak
    // one per repaint and flicker the image as it reloads.
    if (!urls.has(path)) {
      urls.set(path, URL.createObjectURL(new Blob([pending])));
    }
    return urls.get(path);
  }

  if (!repo) return null;
  const { owner, repo: name, defaultBranch } = repo;
  return `https://raw.githubusercontent.com/${owner}/${name}/${defaultBranch}/${path}`;
}

/**
 * A still for a hosted video.
 *
 * YouTube publishes one at a predictable address, so a slide gets a real
 * picture without an API call or a key. Everything else needs a poster
 * committed alongside — which is what the grammar's `poster` is for, and
 * saying so is more useful than showing a grey box.
 */
export function videoThumb(url) {
  const text = String(url ?? "");
  const youtube =
    text.match(/youtu\.be\/([\w-]{6,})/) ||
    text.match(/[?&]v=([\w-]{6,})/) ||
    text.match(/youtube\.com\/embed\/([\w-]{6,})/);
  if (youtube) return `https://img.youtube.com/vi/${youtube[1]}/hqdefault.jpg`;
  return null;
}

/** What a video URL is, for the label under a poster. */
export function videoHost(url) {
  const text = String(url ?? "");
  if (/youtu\.?be/.test(text)) return "YouTube";
  if (/vimeo\.com/.test(text)) return "Vimeo";
  try {
    return new URL(text).hostname.replace(/^www\./, "");
  } catch {
    return "video";
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Choose what goes in a placeholder.
 *
 * region    which placeholder is being filled
 * kind      "image" or "video", from what the layout allows there
 * images    repo paths, for reuse
 * resolve   path -> a URL a browser can load, for the thumbnails
 * onPick({type, src, url})  a choice was made
 * onUpload(files)           files to put through the asset policy
 * onClear()                 empty the placeholder
 */
export function mediaPicker(host, { region, kind, images, resolve, onPick, onUpload, onClear }) {
  host.innerHTML = "";
  const panel = el("div", "media-picker");
  panel.append(el("h4", null, `${kind === "video" ? "Video" : "Picture"} for ${region}`));

  if (kind !== "video") {
    // Upload. The policy runs before the bytes reach a commit, and the
    // panel says so -- a clinical photograph carrying GPS into a public
    // repo is not a thing to discover later.
    const drop = el("div", "media-drop");
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.multiple = false;
    file.id = "media-upload";
    const label = el("label", "media-droplabel", "Upload a picture");
    label.htmlFor = file.id;
    drop.append(label, file);
    drop.append(
      el(
        "p",
        "hint",
        "Resized to 2000px and stripped of all metadata before it is " +
          "committed — location, camera, timestamp."
      )
    );
    file.addEventListener("change", () => {
      if (file.files?.length) onUpload?.([...file.files]);
    });
    panel.append(drop);
  }

  // Link. The only route for video, and a legitimate one for a picture
  // that lives somewhere the repo should not copy.
  const linkRow = el("div", "media-link");
  const url = el("input", "text grow");
  url.type = "url";
  url.placeholder =
    kind === "video" ? "https://www.youtube.com/watch?v=…" : "https://…";
  url.setAttribute("aria-label", `Link for ${region}`);
  const use = el("button", "primary", "Use link");
  use.type = "button";
  use.addEventListener("click", () => {
    const value = url.value.trim();
    if (!value) return;
    onPick?.(kind === "video" ? { type: "video", url: value } : { type: "image", src: value });
  });
  linkRow.append(url, use);
  panel.append(linkRow);

  if (kind !== "video" && images.length) {
    panel.append(el("h4", null, "Already in this course"));
    const grid = el("div", "media-grid");
    for (const path of images) {
      const button = el("button", "media-thumb");
      button.type = "button";
      button.title = path;
      const img = el("img");
      img.src = resolve(path) ?? "";
      img.alt = "";
      img.loading = "lazy";
      button.append(img, el("span", null, path.split("/").pop()));
      button.addEventListener("click", () => onPick?.({ type: "image", src: path }));
      grid.append(button);
    }
    panel.append(grid);
  }

  const clear = el("button", null, "Empty this placeholder");
  clear.type = "button";
  clear.addEventListener("click", () => onClear?.());
  panel.append(clear);

  host.append(panel);
}
