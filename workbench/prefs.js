// What this browser remembers between visits.
//
// Small, and deliberately so: a preference is a convenience, and losing
// one must never lose work or change what a repository holds. Everything
// here degrades to "no preference" when storage is blocked, which is what
// a private window does.
//
// The branch is the one that matters. Save writes to a draft branch, and
// opening the repository again read the *default* branch -- so a reload
// showed the published version and the morning's work appeared to be
// gone. It was not gone; it was on a branch nothing was looking at.

const BRANCH_KEY = "fair.wb.branch";
const REPO_KEY = "fair.wb.repo";

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function all() {
  try {
    const parsed = JSON.parse(read(BRANCH_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupted value is no preference, not an exception: this runs
    // before anything is on screen.
    return {};
  }
}

const keyFor = (owner, repo) => `${owner}/${repo}`;

/** The branch this browser was last working on in a repository. */
export function lastBranch(owner, repo) {
  const value = all()[keyFor(owner, repo)];
  return typeof value === "string" && value ? value : null;
}

export function rememberBranch(owner, repo, branch) {
  const map = all();
  if (branch) map[keyFor(owner, repo)] = branch;
  else delete map[keyFor(owner, repo)];
  return write(BRANCH_KEY, JSON.stringify(map));
}

export function forgetBranch(owner, repo) {
  return rememberBranch(owner, repo, null);
}

/** The library this browser last had open, as "owner/repo". */
export function lastRepo() {
  const value = read(REPO_KEY);
  return typeof value === "string" && value.includes("/") ? value : null;
}

export function rememberRepo(fullName) {
  return write(REPO_KEY, fullName || null);
}
