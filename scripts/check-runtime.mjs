const REQUIRED_NODE_MAJOR = 20;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split(".")[0], 10);

if (!Number.isInteger(currentMajor) || currentMajor < REQUIRED_NODE_MAJOR) {
  console.error(
    `[ERROR] Node.js ${REQUIRED_NODE_MAJOR} or newer is required (current: ${currentVersion}).`
  );
  process.exitCode = 1;
}
