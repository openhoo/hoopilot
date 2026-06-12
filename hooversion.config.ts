export default {
  branches: ["main"],
  packages: [
    {
      name: "@openhoo/hoopilot",
      path: ".",
      type: "node",
      manifest: "package.json",
      changelog: "CHANGELOG.md",
      scopes: ["@openhoo/hoopilot", "hoopilot"],
      dependencies: [],
    },
  ],
  hooks: {
    afterVersion: ["bun install --lockfile-only --ignore-scripts"],
  },
  github: {
    releases: true,
  },
};
