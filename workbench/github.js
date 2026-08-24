// Everything the workbench needs from GitHub, browser-direct.
//
// api.github.com sends `Access-Control-Allow-Origin: *`, so reads, commits,
// branches and pull requests all work from a static page with no proxy and
// no server. Only the OAuth token exchange cannot (github.com's OAuth
// endpoints send no CORS headers at all) — see auth.js.
//
// Writes go through the **Git Data API** (blob -> tree -> commit -> ref),
// not the Contents API. Contents writes one file per commit, so saving a
// slide and its image would land as two commits, and a failure between
// them would leave the branch describing a slide whose picture is missing.
// The Git Data path is one commit or none.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async request(path, { method = "GET", body, raw = false } = {}) {
    const url = path.startsWith("http") ? path : API + path;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Rate limiting is the failure a browser hits first, and "403" alone
      // sends people looking for a permissions problem they do not have.
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 403 && remaining === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
        const mins = Math.max(1, Math.round((reset - Date.now()) / 60000));
        throw new GitHubError(
          `GitHub rate limit reached — resets in about ${mins} min. Signing in raises it from 60 to 5000 an hour.`,
          res.status,
          url
        );
      }
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch {
        /* not json */
      }

      // A fine-grained token that can read a public repo but not write to it
      // gives this, and GitHub's wording sends people looking in the wrong
      // place. Reading a public repo needs no permission at all, so the
      // token may simply have no access to the owner's repositories.
      if (res.status === 403 && /not accessible by personal access token/i.test(detail)) {
        const owner = url.match(/\/repos\/([^/]+)\//)?.[1] ?? "the owner";
        throw new GitHubError(
          `Your token cannot write to ${owner}. Reading worked because the ` +
            "repository is public. Check three things on the token: its " +
            `resource owner is ${owner} (not your personal account), this ` +
            "repository is selected, and it grants Contents: read and write " +
            "plus Pull requests: read and write. If " +
            `${owner} is an organisation, it may also need to approve the ` +
            "token under Settings → Personal access tokens.",
          res.status,
          url
        );
      }
      throw new GitHubError(
        `${method} ${url.replace(API, "")} failed (${res.status})${detail ? `: ${detail}` : ""}`,
        res.status,
        url
      );
    }
    return res.status === 204 ? null : res.json();
  }

  // ---- identity and discovery ----------------------------------------

  me() {
    return this.request("/user");
  }

  /** Repos the user can push to, most recently updated first. */
  async repos(limit = 100) {
    const all = await this.request(
      `/user/repos?per_page=${limit}&sort=updated&affiliation=owner,collaborator,organization_member`
    );
    return all.filter((r) => r.permissions?.push);
  }

  repo(owner, name) {
    return this.request(`/repos/${owner}/${name}`);
  }

  /** Can this token push here? Checked on open, not at submit time. */
  async canWrite(owner, name) {
    const repo = await this.repo(owner, name);
    return Boolean(repo.permissions?.push);
  }

  /** Every blob path at a ref, in one call. */
  async tree(owner, name, ref = "HEAD") {
    const data = await this.request(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
    if (data.truncated) {
      throw new GitHubError(
        "repository tree is too large to read in one request",
        200,
        ""
      );
    }
    return data.tree.filter((e) => e.type === "blob").map((e) => e.path);
  }

  /** File contents as text. */
  async file(owner, name, path, ref = "HEAD") {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${path}`
    );
    if (!res.ok) {
      throw new GitHubError(`cannot read ${path} (${res.status})`, res.status, path);
    }
    return res.text();
  }

  // ---- branches -------------------------------------------------------

  async defaultBranch(owner, name) {
    return (await this.repo(owner, name)).default_branch;
  }

  async branchExists(owner, name, branch) {
    try {
      await this.request(
        `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`
      );
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async headSha(owner, name, branch) {
    const ref = await this.request(
      `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    return ref.object.sha;
  }

  /** Create `branch` at `from`'s tip, or leave it alone if it exists. */
  async ensureBranch(owner, name, branch, from) {
    if (await this.branchExists(owner, name, branch)) return false;
    const sha = await this.headSha(owner, name, from);
    await this.request(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return true;
  }

  // ---- writing --------------------------------------------------------

  /**
   * One commit carrying every file in `files`.
   *
   * files: [{path, content}] where content is a string, or
   *        [{path, base64}] for binary (images).
   */
  async commit(owner, name, branch, message, files) {
    if (!files.length) throw new GitHubError("nothing to commit", 0, "");

    const parent = await this.headSha(owner, name, branch);
    const base = await this.request(
      `/repos/${owner}/${name}/git/commits/${parent}`
    );

    const blobs = [];
    for (const file of files) {
      const blob = await this.request(`/repos/${owner}/${name}/git/blobs`, {
        method: "POST",
        body:
          file.base64 !== undefined
            ? { content: file.base64, encoding: "base64" }
            : { content: file.content, encoding: "utf-8" },
      });
      blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const tree = await this.request(`/repos/${owner}/${name}/git/trees`, {
      method: "POST",
      body: { base_tree: base.tree.sha, tree: blobs },
    });

    const created = await this.request(`/repos/${owner}/${name}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.sha, parents: [parent] },
    });

    await this.request(
      `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: "PATCH", body: { sha: created.sha } }
    );
    return created.sha;
  }

  // ---- provisioning ---------------------------------------------------

  /**
   * Create a repository under the signed-in account.
   *
   * `auto_init` is not optional in practice: a repository with no commit
   * has no default branch, and every write path here -- headSha, trees,
   * refs -- needs one to exist. Without it the first commit has to go
   * through a different API and the seeding code forks in two.
   */
  async createRepo({ name, description = "", private: isPrivate = true }) {
    return this.request("/user/repos", {
      method: "POST",
      body: {
        name,
        description,
        private: isPrivate,
        auto_init: true,
        has_issues: true,
        has_wiki: false,
      },
    });
  }

  /** Whether a name is already taken under this owner. */
  async repoExists(owner, name) {
    try {
      await this.request(`/repos/${owner}/${name}`);
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  // ---- pull requests --------------------------------------------------

  async openPull(owner, name, { head, base, title, body }) {
    return this.request(`/repos/${owner}/${name}/pulls`, {
      method: "POST",
      body: { head, base, title, body },
    });
  }

  /** The open PR for a branch, if there is one. */
  async pullForBranch(owner, name, branch) {
    const pulls = await this.request(
      `/repos/${owner}/${name}/pulls?state=open&head=${owner}:${branch}`
    );
    return pulls[0] || null;
  }

  /** Commits touching a path, newest first — the History panel. */
  commits(owner, name, { branch, path, limit = 30 } = {}) {
    const params = new URLSearchParams({ per_page: String(limit) });
    if (branch) params.set("sha", branch);
    if (path) params.set("path", path);
    return this.request(`/repos/${owner}/${name}/commits?${params}`);
  }
}

/** owner/repo, or a github.com URL, or null. */
export function parseRepo(input) {
  const raw = (input || "").trim().replace(/\/+$/, "");
  let m = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m && !raw.includes(":")) return { owner: m[1], repo: m[2] };
  m = raw.match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A draft branch name that is stable per user and block. */
export function draftBranch(login, blockId) {
  const slug = String(blockId || "course")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `draft/${login}/${slug}`.slice(0, 240);
}
