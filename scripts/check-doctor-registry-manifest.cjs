const { doctorRegistryManifestProblems } = require('../dist/doctor-registry-manifest');
const { discoverChecks } = require('../dist/registry');

const problems = doctorRegistryManifestProblems(discoverChecks());
if (problems.length > 0) {
  throw new Error(`doctor registry manifest mismatch: ${problems.join('; ')}`);
}
