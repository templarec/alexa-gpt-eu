const fs = require("fs");
const { execSync } = require("child_process");

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
  try {
    execSync("git diff --quiet && git diff --cached --quiet", {
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    return true;
  }
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
