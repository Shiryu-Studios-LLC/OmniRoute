import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig(),
  // OmniRoute's local build script assembles a standalone Node artifact and intentionally
  // changes distDir to .build/next. OpenNext needs the native Next.js .next output, so the
  // Cloudflare target runs Next directly with a cloud-only distDir without changing local builds.
  buildCommand: "NEXT_DIST_DIR=.next next build",
};
