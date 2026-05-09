const fs = require("fs");
const { execSync } = require("child_process");
function commandSucceeds(command) {
  try {
    execSync(command, {
      stdio: "ignore",
    });

    return true;
  } catch (error) {
    return false;
  }
}
function safeExec(command, fallback = null) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    return fallback;
  }
}

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
    return pkg.version || null;
  } catch (error) {
    return null;
  }
}

function isGitDirty() {
  const hasUnstagedChanges = !commandSucceeds("git diff --quiet");
  const hasStagedChanges = !commandSucceeds("git diff --cached --quiet");

  const untrackedFiles = safeExec(
    "git ls-files --others --exclude-standard",
    "",
  )
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => file !== "build-info.json");

  const hasUntrackedFiles = untrackedFiles.length > 0;

  return hasUnstagedChanges || hasStagedChanges || hasUntrackedFiles;
}

const buildInfo = {
  packageVersion: getPackageVersion(),
  gitCommit: safeExec("git rev-parse HEAD", null),
  gitShortCommit: safeExec("git rev-parse --short HEAD", null),
  gitCommitMessage: safeExec("git log -1 --pretty=%s", null),
  gitBranch: safeExec("git rev-parse --abbrev-ref HEAD", null),
  gitTag: safeExec("git describe --tags --exact-match", null),
  gitDirty: isGitDirty(),
  deployedAt: new Date().toISOString(),
};

fs.writeFileSync("./build-info.json", JSON.stringify(buildInfo, null, 2));
console.log("BUILD INFO WRITTEN");
console.log(buildInfo);
